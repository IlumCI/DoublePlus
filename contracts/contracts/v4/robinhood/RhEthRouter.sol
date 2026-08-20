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

/// @title RhEthRouter
/// @notice One-tap ETH<->coin trading for the ETH-reward launchpad. Every coin
///         pairs against WETH, so a buy just wraps ETH and swaps WETH->coin
///         through the coin's own V4 pool, and a sell reverses it and unwraps to
///         ETH. No external hops or per-coin config: the pool key is rebuilt
///         from (coin, WETH).
contract RhEthRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    int24 internal constant TICK_SPACING = 60;
    uint24 internal constant LP_FEE = 0;

    IPoolManager public immutable poolManager;
    IHooks public immutable hook;
    address public immutable weth;

    struct V4Swap {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
    }

    error Slippage();

    constructor(IPoolManager pm, address hook_, address weth_) {
        poolManager = pm;
        hook = IHooks(hook_);
        weth = weth_;
    }

    receive() external payable {}

    function _poolKey(address coin) internal view returns (PoolKey memory key, bool coinIsC0) {
        coinIsC0 = coin < weth;
        key = PoolKey({
            currency0: Currency.wrap(coinIsC0 ? coin : weth),
            currency1: Currency.wrap(coinIsC0 ? weth : coin),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: hook
        });
    }

    function buy(address coin, uint256 minCoinOut) external payable nonReentrant returns (uint256 coinOut) {
        require(msg.value > 0, "no ETH");
        IWrappedNative(weth).deposit{value: msg.value}();
        (PoolKey memory key, bool coinIsC0) = _poolKey(coin);
        // Spend WETH: zeroForOne when WETH is currency0 (i.e. coin is currency1).
        coinOut = _swap(key, !coinIsC0, msg.value);
        if (coinOut < minCoinOut) revert Slippage();
        IERC20(coin).safeTransfer(msg.sender, coinOut);
    }

    function sell(address coin, uint256 amountIn, uint256 minEthOut) external nonReentrant returns (uint256 ethOut) {
        IERC20(coin).safeTransferFrom(msg.sender, address(this), amountIn);
        (PoolKey memory key, bool coinIsC0) = _poolKey(coin);
        // Spend coin: zeroForOne when coin is currency0.
        uint256 wethOut = _swap(key, coinIsC0, amountIn);
        IWrappedNative(weth).withdraw(wethOut);
        ethOut = wethOut;
        if (ethOut < minEthOut) revert Slippage();
        (bool ok, ) = msg.sender.call{value: ethOut}("");
        require(ok, "eth xfer");
    }

    function _swap(PoolKey memory key, bool zeroForOne, uint256 amountIn) internal returns (uint256 amountOut) {
        if (amountIn == 0) return 0;
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
