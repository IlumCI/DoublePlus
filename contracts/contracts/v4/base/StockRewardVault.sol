// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @title StockRewardVault
/// @notice Per-coin holder-reward vault: "hold the coin, earn the paired
///         stock." A slice of every trade fee lands here (the vault is a
///         payee on the coin's StockFeeHook pool). Fees arrive as a mix of
///         the coin (from buys) and the stock (from sells); `convert` swaps
///         the coin balance to the stock through the coin's own v4 pool so
///         everything the vault distributes is the stock token.
///
///         Distribution is snapshot-based to stop last-second gaming: a
///         keeper reads holder balances off chain, builds a Merkle tree of
///         (index, account, amount) leaves for a fixed stock budget, and
///         posts the root. Holders claim their stock with a proof. Nobody,
///         keeper included, can move funds except into holders' hands through
///         a posted epoch; unallocated stock only ever grows the next epoch.
contract StockRewardVault is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    address public immutable coin;
    address public immutable stock; // reward token (the pair)
    address public immutable keeper;
    bool public immutable coinIsCurrency0;
    PoolKey internal key;

    struct Epoch {
        bytes32 root;
        uint256 amount; // stock allocated to this epoch
    }

    Epoch[] public epochs;
    uint256 public allocated; // total stock committed across all epochs
    mapping(uint256 => mapping(uint256 => bool)) public claimed; // epoch => index => claimed

    error NotKeeper();
    error NotPoolManager();
    error AlreadyClaimed();
    error BadProof();
    error Overallocated();

    event Converted(uint256 coinIn, uint256 stockOut);
    event EpochPosted(uint256 indexed epoch, bytes32 root, uint256 amount);
    event Claimed(uint256 indexed epoch, uint256 index, address indexed account, uint256 amount);

    modifier onlyKeeper() {
        if (msg.sender != keeper) revert NotKeeper();
        _;
    }

    constructor(
        IPoolManager poolManager_,
        address coin_,
        address stock_,
        address keeper_,
        PoolKey memory key_,
        bool coinIsCurrency0_
    ) {
        poolManager = poolManager_;
        coin = coin_;
        stock = stock_;
        keeper = keeper_;
        key = key_;
        coinIsCurrency0 = coinIsCurrency0_;
    }

    /// @notice The coin/stock pool key this vault swaps through.
    function poolKey() external view returns (PoolKey memory) {
        return key;
    }

    /// @notice Stock not yet committed to an epoch, free for the next one.
    ///         `allocated` is the sum still owed on posted epochs; claims drop
    ///         both the balance and `allocated`, so this stays the free float.
    function distributable() public view returns (uint256) {
        uint256 bal = IERC20(stock).balanceOf(address(this));
        return bal > allocated ? bal - allocated : 0;
    }

    // ---------------------------------------------------------------------
    // Keeper: convert coin -> stock, then post an epoch
    // ---------------------------------------------------------------------

    /// @notice Swap the vault's whole coin balance into the stock via the
    ///         coin's v4 pool. Keeper-only; `minStockOut` guards slippage.
    function convert(uint256 minStockOut) external onlyKeeper nonReentrant returns (uint256 stockOut) {
        uint256 coinBal = IERC20(coin).balanceOf(address(this));
        if (coinBal == 0) return 0;
        bytes memory res = poolManager.unlock(abi.encode(coinBal, minStockOut));
        stockOut = abi.decode(res, (uint256));
        emit Converted(coinBal, stockOut);
    }

    /// @notice Allocate `amount` of the vault's stock to a Merkle epoch of
    ///         (index, account, amount) leaves. Keeper-only.
    function postEpoch(bytes32 root, uint256 amount) external onlyKeeper returns (uint256 epochId) {
        uint256 bal = IERC20(stock).balanceOf(address(this));
        if (allocated + amount > bal) revert Overallocated();
        epochId = epochs.length;
        epochs.push(Epoch({root: root, amount: amount}));
        allocated += amount;
        emit EpochPosted(epochId, root, amount);
    }

    // ---------------------------------------------------------------------
    // Holder claims
    // ---------------------------------------------------------------------

    function claim(uint256 epochId, uint256 index, address account, uint256 amount, bytes32[] calldata proof)
        external
        nonReentrant
    {
        if (claimed[epochId][index]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(index, account, amount))));
        if (!MerkleProof.verify(proof, epochs[epochId].root, leaf)) revert BadProof();
        claimed[epochId][index] = true;
        allocated -= amount;
        IERC20(stock).safeTransfer(account, amount);
        emit Claimed(epochId, index, account, amount);
    }

    function epochCount() external view returns (uint256) {
        return epochs.length;
    }

    // ---------------------------------------------------------------------
    // v4 swap plumbing (coin -> stock through the coin's pool)
    // ---------------------------------------------------------------------

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != address(poolManager)) revert NotPoolManager();
        (uint256 amountIn, uint256 minOut) = abi.decode(data, (uint256, uint256));

        // Sell the coin for the stock: zeroForOne when the coin is currency0.
        bool zeroForOne = coinIsCurrency0;
        BalanceDelta d = poolManager.swap(
            key,
            SwapParams({
                zeroForOne: zeroForOne,
                amountSpecified: -int256(amountIn),
                sqrtPriceLimitX96: zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Settle the coin we owe, take the stock we got.
        _settleNeg(coinIsCurrency0 ? key.currency0 : key.currency1, coinIsCurrency0 ? d.amount0() : d.amount1());
        uint256 out = _takePositive(
            coinIsCurrency0 ? key.currency1 : key.currency0,
            coinIsCurrency0 ? d.amount1() : d.amount0()
        );
        require(out >= minOut, "slippage");
        return abi.encode(out);
    }

    function _settleNeg(Currency currency, int128 amount) private {
        if (amount >= 0) return;
        poolManager.sync(currency);
        IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), uint256(uint128(-amount)));
        poolManager.settle();
    }

    function _takePositive(Currency currency, int128 amount) private returns (uint256 value) {
        if (amount <= 0) return 0;
        value = uint256(uint128(amount));
        poolManager.take(currency, address(this), value);
    }
}
