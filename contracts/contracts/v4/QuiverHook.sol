// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {BaseHook} from "@uniswap/v4-periphery/src/utils/BaseHook.sol";
import {Hooks} from "@uniswap/v4-core/src/libraries/Hooks.sol";
import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {PoolId, PoolIdLibrary} from "@uniswap/v4-core/src/types/PoolId.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

import {IQuiverToken} from "./interfaces/IQuiverToken.sol";

interface IWrappedQuote {
    function withdraw(uint256) external;
    function deposit() external payable;
}

/// @title QuiverHook
/// @notice Singleton Uniswap V4 hook and fee vault for the Quiver launchpad.
///
///         Launched tokens pair with the chain's quote asset (held in the WETH
///         slot; on Arc this is native USDC). Every swap through a pool pays a
///         per-token tax fixed at launch that the hook skims in `afterSwap` —
///         so the fee is collected on ALL trades through the pool, not just
///         those routed via the app. Skimmed fees accrue per token; anyone can
///         then call `harvest`, which normalises everything to the quote asset
///         and splits it 80/20:
///
///           1. creator  — 80%: pushed straight to the creator's wallet
///           2. protocol — 20%: sent to the protocol treasury
///
///         All swaps the hook performs run through the PoolManager's own
///         `unlock`, so the hook is its own router and needs no external one.
contract QuiverHook is BaseHook, Ownable, ReentrancyGuard, IUnlockCallback {
    using SafeERC20 for IERC20;
    using PoolIdLibrary for PoolKey;

    uint16 internal constant BPS = 10_000;

    /// @notice Creator share of every harvest, in bps. The remainder goes to
    ///         the protocol treasury.
    uint16 public constant CREATOR_FEE_BPS = 8_000;

    /// @notice The WETH the launchpad pools are quoted in.
    address public immutable WETH;

    struct PoolConfig {
        address token; // the launched QuiverToken
        address stock; // reward token holders receive (an ERC-20)
        address creator;
        uint16 taxBps;
        bool tokenIsCurrency0; // orientation of the launched token in the pool
        bool registered;
        PoolKey poolKey; // the launched token's own WETH pool
        PoolKey stockKey; // quote/stock pool used to buy the reward
    }

    /// @notice Factory allowed to register pools. Set once by the owner.
    address public factory;
    /// @notice Where the protocol's 25% share (WETH) is sent.
    address public protocolTreasury;
    /// @notice Quote token stocks are priced in (USDG). Stock rewards are
    ///         bought WETH -> quote -> stock, matching on-chain liquidity.
    address public quote;
    PoolKey internal _quoteKey; // WETH/quote pool used for the first hop

    mapping(PoolId => PoolConfig) internal _config;
    /// @notice token => WETH fees awaiting harvest (from sells).
    mapping(address => uint256) public wethFees;
    /// @notice token => launched-token fees awaiting harvest (from buys).
    mapping(address => uint256) public tokenFees;
    /// @notice token => WETH claimable by its creator.
    mapping(address => uint256) public creatorClaimable;
    mapping(address => PoolId) internal _poolOf;

    struct SwapAction {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    event PoolRegistered(address indexed token, PoolId indexed id, address stock, uint16 taxBps);
    event FeeAccrued(address indexed token, bool weth, uint256 amount);
    event Harvested(address indexed token, uint256 toCreator, uint256 toHolders, uint256 toProtocol);
    event CreatorClaimed(address indexed token, address indexed creator, uint256 amount);
    event ProtocolTreasurySet(address indexed treasury);
    event QuoteRouteSet(address indexed quote);
    event FactorySet(address indexed factory);

    error NotFactory();
    error AlreadySet();
    error NotRegistered();
    error NotCreator();

    constructor(IPoolManager pm, address owner_, address treasury_, address weth_)
        BaseHook(pm)
        Ownable(owner_)
    {
        require(treasury_ != address(0) && weth_ != address(0), "zero");
        protocolTreasury = treasury_;
        WETH = weth_;
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setFactory(address factory_) external onlyOwner {
        require(factory_ != address(0), "factory=0");
        factory = factory_;
        emit FactorySet(factory_);
    }

    function setProtocolTreasury(address treasury_) external onlyOwner {
        require(treasury_ != address(0), "treasury=0");
        protocolTreasury = treasury_;
        emit ProtocolTreasurySet(treasury_);
    }

    /// @notice Configure the WETH->quote hop used to buy stock rewards.
    function setQuoteRoute(address quote_, PoolKey calldata quoteKey_) external onlyOwner {
        quote = quote_;
        _quoteKey = quoteKey_;
        emit QuoteRouteSet(quote_);
    }

    function quoteKey() external view returns (PoolKey memory) {
        return _quoteKey;
    }

    // ---------------------------------------------------------------------
    // Hook permissions
    // ---------------------------------------------------------------------

    function getHookPermissions() public pure override returns (Hooks.Permissions memory p) {
        p.afterSwap = true;
        p.afterSwapReturnDelta = true;
    }

    // ---------------------------------------------------------------------
    // Registration (factory only)
    // ---------------------------------------------------------------------

    function registerPool(
        PoolKey calldata key,
        address token,
        address stock,
        address creator,
        uint16 taxBps,
        bool tokenIsCurrency0,
        PoolKey calldata stockKey
    ) external {
        if (msg.sender != factory) revert NotFactory();
        PoolId id = key.toId();
        PoolConfig storage c = _config[id];
        if (c.registered) revert AlreadySet();
        c.token = token;
        c.stock = stock;
        c.creator = creator;
        c.taxBps = taxBps;
        c.tokenIsCurrency0 = tokenIsCurrency0;
        c.registered = true;
        c.poolKey = key;
        c.stockKey = stockKey;
        _poolOf[token] = id;
        emit PoolRegistered(token, id, stock, taxBps);
    }

    function config(PoolId id) external view returns (PoolConfig memory) {
        return _config[id];
    }

    // ---------------------------------------------------------------------
    // afterSwap: skim the tax on every trade
    // ---------------------------------------------------------------------

    function _afterSwap(
        address,
        PoolKey calldata key,
        SwapParams calldata params,
        BalanceDelta delta,
        bytes calldata
    ) internal override returns (bytes4, int128) {
        PoolConfig storage c = _config[key.toId()];
        if (!c.registered || c.taxBps == 0) return (BaseHook.afterSwap.selector, int128(0));

        // Charge the tax in the swap's UNSPECIFIED currency, so it applies to
        // BOTH exact-input (fee comes out of the output) and exact-output (fee is
        // added to the input) trades. This means every swap through the pool is
        // taxed — none can dodge the fee by using an exact-output order.
        bool exactInput = params.amountSpecified < 0;
        bool unspecifiedIsCurrency1 = (params.zeroForOne == exactInput);
        Currency unspecified = unspecifiedIsCurrency1 ? key.currency1 : key.currency0;
        int128 unspecifiedAmount = unspecifiedIsCurrency1 ? delta.amount1() : delta.amount0();

        uint256 magnitude = unspecifiedAmount < 0
            ? uint256(uint128(-unspecifiedAmount))
            : uint256(uint128(unspecifiedAmount));
        uint256 fee = (magnitude * c.taxBps) / BPS;
        if (fee == 0) return (BaseHook.afterSwap.selector, int128(0));

        poolManager.take(unspecified, address(this), fee);

        bool feeIsToken = Currency.unwrap(unspecified) == c.token;
        if (feeIsToken) {
            tokenFees[c.token] += fee;
        } else {
            wethFees[c.token] += fee;
        }
        emit FeeAccrued(c.token, !feeIsToken, fee);

        return (BaseHook.afterSwap.selector, int128(int256(fee)));
    }

    // ---------------------------------------------------------------------
    // harvest: normalise to the quote asset, split 80/20, push
    // ---------------------------------------------------------------------

    /// @notice Permissionless harvest with no slippage bounds on the internal
    ///         swaps. Convenient, but sandwichable — prefer `harvestBounded` from
    ///         a keeper that can compute expected outputs.
    function harvest(address token) external nonReentrant {
        _harvest(token, 0, 0);
    }

    /// @notice Harvest with slippage floors on the internal swaps, so a sandwich
    ///         attacker can't skim the holder share. `minWeth` bounds the
    ///         token->WETH fee conversion, `minStock` the holder stock buy; zero
    ///         disables that bound. A keeper computes these off-chain from the
    ///         live pool price.
    function harvestBounded(address token, uint256 minWeth, uint256 minStock)
        external
        nonReentrant
    {
        _harvest(token, minWeth, minStock);
    }

    function _harvest(address token, uint256 minWeth, uint256 /* minStock, unused */) private {
        PoolConfig storage c = _config[_poolOf[token]];
        if (!c.registered) revert NotRegistered();

        // 1. Convert launched-token fees (from buys) into WETH.
        uint256 tf = tokenFees[token];
        if (tf > 0) {
            tokenFees[token] = 0;
            Currency tokenCurrency = c.tokenIsCurrency0 ? c.poolKey.currency0 : c.poolKey.currency1;
            wethFees[token] += _swap(c.poolKey, tokenCurrency, tf, minWeth);
        }

        uint256 total = wethFees[token];
        if (total == 0) {
            emit Harvested(token, 0, 0, 0);
            return;
        }
        wethFees[token] = 0;

        // Split 80/20: creator 80%, protocol 20% (dust to protocol). Both are
        // pushed in the same transaction — the creator never has to claim.
        uint256 toCreator = (total * CREATOR_FEE_BPS) / BPS;
        uint256 toProtocol = total - toCreator;

        _pushQuote(c.creator, toCreator);
        if (toProtocol > 0) {
            _pushQuote(protocolTreasury, toProtocol);
        }

        emit Harvested(token, toCreator, 0, toProtocol);
    }

    /// @dev Deliver a fee share as NATIVE quote (unwrap first) so recipients
    ///      see plain dollars, falling back to the wrapped ERC-20 for
    ///      recipients that cannot receive native transfers.
    function _pushQuote(address to, uint256 amount) private {
        if (amount == 0) return;
        IWrappedQuote(WETH).withdraw(amount);
        (bool ok, ) = to.call{value: amount, gas: 30_000}("");
        if (!ok) {
            IWrappedQuote(WETH).deposit{value: amount}();
            IERC20(WETH).safeTransfer(to, amount);
        }
    }

    /// @notice Accept native currency from the wrapped-quote unwrap.
    receive() external payable {}

    /// @notice Creator withdraws their accrued WETH fees.
    function claimCreatorFees(address token) external nonReentrant returns (uint256 amount) {
        PoolConfig storage c = _config[_poolOf[token]];
        if (!c.registered) revert NotRegistered();
        if (msg.sender != c.creator) revert NotCreator();
        amount = creatorClaimable[token];
        if (amount == 0) return 0;
        creatorClaimable[token] = 0;
        IERC20(WETH).safeTransfer(msg.sender, amount);
        emit CreatorClaimed(token, msg.sender, amount);
    }

    // ---------------------------------------------------------------------
    // Swap plumbing (our own router, via PoolManager.unlock)
    // ---------------------------------------------------------------------

    function _swap(PoolKey memory key, Currency currencyIn, uint256 amountIn, uint256 minOut)
        internal
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        bool zeroForOne = Currency.unwrap(currencyIn) == Currency.unwrap(key.currency0);
        bytes memory res = poolManager.unlock(abi.encode(SwapAction(key, zeroForOne, amountIn)));
        amountOut = abi.decode(res, (uint256));
        require(amountOut >= minOut, "slippage");
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        SwapAction memory a = abi.decode(data, (SwapAction));

        BalanceDelta delta = poolManager.swap(
            a.key,
            SwapParams({
                zeroForOne: a.zeroForOne,
                amountSpecified: -int256(a.amountIn),
                sqrtPriceLimitX96: a.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        _resolve(a.key.currency0, delta.amount0());
        _resolve(a.key.currency1, delta.amount1());

        uint256 out = a.zeroForOne ? uint256(uint128(delta.amount1())) : uint256(uint128(delta.amount0()));
        return abi.encode(out);
    }

    /// @dev Settle what we owe / take what we're owed for one currency.
    function _resolve(Currency currency, int128 amount) internal {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(currency);
            IERC20(Currency.unwrap(currency)).safeTransfer(address(poolManager), owed);
            poolManager.settle();
        } else if (amount > 0) {
            poolManager.take(currency, address(this), uint256(uint128(amount)));
        }
    }

    // ---------------------------------------------------------------------
    // Helpers
    // ---------------------------------------------------------------------

    function _wethSide(PoolKey memory key) internal view returns (Currency) {
        return Currency.unwrap(key.currency0) == WETH ? key.currency0 : key.currency1;
    }
}
