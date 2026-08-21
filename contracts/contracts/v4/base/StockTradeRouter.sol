// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {IHooks} from "@uniswap/v4-core/src/interfaces/IHooks.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

interface IWETH {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @notice Minimal StockFlyFactoryV2 surface: the coin's pair token + hook.
interface IStockFactory {
    function listings(address token)
        external
        view
        returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId);

    function hook() external view returns (address);
}

/// @title StockTradeRouter
/// @notice Pair-denominated buy/sell for StockFlyFactoryV2 coins. A coin trades
///         directly against its own pair token — a tokenized stock or USDC — in
///         the coin's Uniswap v4 pool. No external DEX is touched, so this works
///         for any pair the launchpad allows and can never break on third-party
///         liquidity moving. Callers hold the pair token (USDC/stock):
///
///           buy(coin, pairIn):   pair -[the coin's v4 pool]-> coin
///           sell(coin, coinIn):  coin -[the coin's v4 pool]-> pair
///
///         The coin<->pair leg is the same PoolManager-unlock swap used across
///         the launchpad; the StockFeeHook skims its fee on the way through.
contract StockTradeRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant LP_FEE = 0;

    IPoolManager public immutable poolManager;
    IStockFactory public immutable factory;
    IHooks public immutable hook;
    address public immutable weth;

    struct V4Swap {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    error NotListed();
    error Slippage();
    error NotWethPair();

    constructor(IPoolManager pm, IStockFactory factory_, address weth_) {
        poolManager = pm;
        factory = factory_;
        hook = IHooks(factory_.hook());
        weth = weth_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Native ETH convenience (only for coins paired with WETH)
    // ---------------------------------------------------------------------

    /// @notice Buy a WETH-paired `coin` with native ETH: wrap, then swap through
    ///         the coin's pool. One tap, no external DEX.
    function buyWithEth(address coin, uint256 minCoinOut)
        external
        payable
        nonReentrant
        returns (uint256 coinOut)
    {
        address pair = _pairOf(coin);
        if (pair != weth) revert NotWethPair();
        require(msg.value > 0, "no ETH");
        IWETH(weth).deposit{value: msg.value}();
        coinOut = _v4Swap(coin, pair, pair, msg.value);
        if (coinOut < minCoinOut) revert Slippage();
        IERC20(coin).safeTransfer(msg.sender, coinOut);
    }

    /// @notice Sell a WETH-paired `coin` for native ETH: swap, then unwrap.
    function sellForEth(address coin, uint256 coinIn, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        address pair = _pairOf(coin);
        if (pair != weth) revert NotWethPair();
        IERC20(coin).safeTransferFrom(msg.sender, address(this), coinIn);
        uint256 wethOut = _v4Swap(coin, pair, coin, coinIn);
        IWETH(weth).withdraw(wethOut);
        ethOut = wethOut;
        if (ethOut < minEthOut) revert Slippage();
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "eth xfer");
    }

    /// @notice Buy `coin` with its pair token. Caller must approve `pairIn` of
    ///         the pair token to this router first.
    function buy(address coin, uint256 pairIn, uint256 minCoinOut)
        external
        nonReentrant
        returns (uint256 coinOut)
    {
        address pair = _pairOf(coin);
        IERC20(pair).safeTransferFrom(msg.sender, address(this), pairIn);
        coinOut = _v4Swap(coin, pair, pair, pairIn);
        if (coinOut < minCoinOut) revert Slippage();
        IERC20(coin).safeTransfer(msg.sender, coinOut);
    }

    /// @notice Sell `coin` for its pair token. Caller must approve `coinIn` of
    ///         the coin to this router first.
    function sell(address coin, uint256 coinIn, uint256 minPairOut)
        external
        nonReentrant
        returns (uint256 pairOut)
    {
        address pair = _pairOf(coin);
        IERC20(coin).safeTransferFrom(msg.sender, address(this), coinIn);
        pairOut = _v4Swap(coin, pair, coin, coinIn);
        if (pairOut < minPairOut) revert Slippage();
        IERC20(pair).safeTransfer(msg.sender, pairOut);
    }

    function _pairOf(address coin) internal view returns (address pair) {
        (, pair, , , ) = factory.listings(coin);
        if (pair == address(0)) revert NotListed();
    }

    function _poolKey(address coin, address pair) internal view returns (PoolKey memory key) {
        bool coinIsC0 = coin < pair;
        key = PoolKey({
            currency0: Currency.wrap(coinIsC0 ? coin : pair),
            currency1: Currency.wrap(coinIsC0 ? pair : coin),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
    }

    function _v4Swap(address coin, address pair, address currencyIn, uint256 amountIn)
        internal
        returns (uint256 amountOut)
    {
        if (amountIn == 0) return 0;
        PoolKey memory key = _poolKey(coin, pair);
        bool zeroForOne = currencyIn == Currency.unwrap(key.currency0);
        bytes memory res = poolManager.unlock(abi.encode(V4Swap(key, zeroForOne, amountIn)));
        amountOut = abi.decode(res, (uint256));
    }

    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pool manager");
        V4Swap memory a = abi.decode(data, (V4Swap));

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
}
