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

interface IWrappedNative {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @notice Aerodrome Slipstream (concentrated-liquidity) SwapRouter surface.
///         A Uniswap-V3-periphery fork: the exact-input path encodes each hop's
///         `int24 tickSpacing` (not a uint24 fee) as the 3-byte separator, and
///         the params carry a deadline. This is where the Base tokenized stocks
///         hold their deep USDC liquidity, so the ETH<->stock leg routes here.
interface ISlipstreamRouter {
    struct ExactInputParams {
        bytes path;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
    }

    function exactInput(ExactInputParams calldata params) external payable returns (uint256 amountOut);
}

/// @notice Minimal StockFlyFactoryV2 surface: the coin's pair (stock) and the
///         shared fee hook, so the router needs no per-coin config.
interface IStockFactory {
    function listings(address token)
        external
        view
        returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId);

    function hook() external view returns (address);
}

/// @title StockFlyRouter
/// @notice One-tap ETH buy/sell for coins launched through StockFlyFactoryV2,
///         where each coin pairs a tokenized stock and holders earn that stock.
///         A trader holds only native ETH, so the router bridges the gap using
///         the venue where the stocks actually have deep liquidity — Aerodrome
///         Slipstream — for the ETH<->stock leg, and the coin's own Uniswap v4
///         pool for the stock<->coin leg:
///
///           buy:  ETH -> WETH -[Slipstream: WETH->USDC->stock]-> stock -[v4]-> coin
///           sell: coin -[v4]-> stock -[Slipstream: stock->USDC->WETH]-> WETH -> ETH
///
///         The Slipstream path (tickSpacing-encoded) is supplied by the caller
///         from the discovered route map, so the router needs no per-pair
///         config. The stock<->coin leg always runs through the launched coin's
///         own v4 pool (fee 0, tickSpacing 60, StockFeeHook) via the
///         PoolManager unlock. Mirrors the Robinhood-chain FlyRouter, swapping
///         the Uniswap-V3 leg for Aerodrome Slipstream.
contract StockFlyRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant LP_FEE = 0;

    IPoolManager public immutable poolManager;
    IStockFactory public immutable factory;
    IHooks public immutable hook;
    address public immutable weth;
    ISlipstreamRouter public immutable aeroRouter;

    struct V4Swap {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    error NotListed();
    error Slippage();

    constructor(IPoolManager pm, IStockFactory factory_, address weth_, ISlipstreamRouter aeroRouter_) {
        poolManager = pm;
        factory = factory_;
        hook = IHooks(factory_.hook());
        weth = weth_;
        aeroRouter = aeroRouter_;
    }

    receive() external payable {}

    // ---------------------------------------------------------------------
    // Buy: ETH -> stock -> coin
    // ---------------------------------------------------------------------

    /// @param coin       the launched coin to buy.
    /// @param aeroPath   Slipstream exact-input path WETH -> ... -> stock,
    ///                   tickSpacing-encoded (e.g. WETH,1,USDC,10,stock).
    /// @param minCoinOut slippage floor on the coin received.
    function buy(address coin, bytes calldata aeroPath, uint256 minCoinOut)
        external
        payable
        nonReentrant
        returns (uint256 coinOut)
    {
        address pair = _pairOf(coin);
        require(msg.value > 0, "no ETH");

        // 1. Wrap ETH.
        IWrappedNative(weth).deposit{value: msg.value}();

        // 2. WETH -> stock via Aerodrome Slipstream.
        IERC20(weth).forceApprove(address(aeroRouter), msg.value);
        uint256 stockAmount = aeroRouter.exactInput(
            ISlipstreamRouter.ExactInputParams({
                path: aeroPath,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: msg.value,
                amountOutMinimum: 0
            })
        );

        // 3. stock -> coin via the coin's own v4 pool.
        coinOut = _v4Swap(coin, pair, pair, stockAmount);
        if (coinOut < minCoinOut) revert Slippage();
        IERC20(coin).safeTransfer(msg.sender, coinOut);
    }

    // ---------------------------------------------------------------------
    // Sell: coin -> stock -> ETH
    // ---------------------------------------------------------------------

    /// @param aeroPathReverse Slipstream path stock -> ... -> WETH.
    function sell(address coin, uint256 amountIn, bytes calldata aeroPathReverse, uint256 minEthOut)
        external
        nonReentrant
        returns (uint256 ethOut)
    {
        address pair = _pairOf(coin);
        IERC20(coin).safeTransferFrom(msg.sender, address(this), amountIn);

        // 1. coin -> stock via the coin's own v4 pool.
        uint256 stockAmount = _v4Swap(coin, pair, coin, amountIn);

        // 2. stock -> WETH via Aerodrome Slipstream.
        IERC20(pair).forceApprove(address(aeroRouter), stockAmount);
        uint256 wethAmount = aeroRouter.exactInput(
            ISlipstreamRouter.ExactInputParams({
                path: aeroPathReverse,
                recipient: address(this),
                deadline: block.timestamp,
                amountIn: stockAmount,
                amountOutMinimum: 0
            })
        );

        // 3. Unwrap and pay out native ETH.
        IWrappedNative(weth).withdraw(wethAmount);
        ethOut = wethAmount;
        if (ethOut < minEthOut) revert Slippage();
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "eth xfer");
    }

    // ---------------------------------------------------------------------
    // v4 swap plumbing (coin <-> stock through the launched coin's pool)
    // ---------------------------------------------------------------------

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

    /// @dev Swap `amountIn` of `currencyIn` for the other side of the coin/stock
    ///      pool. `currencyIn` is either the coin (sell) or the stock (buy).
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

        // StockFeeHook ignores hookData, so none is passed.
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
