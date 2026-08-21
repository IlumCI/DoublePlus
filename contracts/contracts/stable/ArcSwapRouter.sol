// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IUniswapV3FactoryCore, IUniswapV3PoolCore} from "./IUniswapV3Core.sol";

/// @title ArcSwapRouter
/// @author arcx.fun
/// @notice Minimal swap entry for arcx launch pools on Arc. Buys are paid in
///         the chain's native USDC (msg.value); sells return native USDC.
///         Arc exposes native USDC as an ERC-20 at a fixed interface address
///         with 6 decimals mirroring the 18-decimal native balance, so this
///         router simply holds native and pays pools through that interface.
contract ArcSwapRouter is ReentrancyGuard {
    using SafeERC20 for IERC20;

    error NotPool();
    error ZeroAmount();
    error SlippageExceeded();
    error PoolMissing();
    error NativeTransferFailed();

    /// @dev Native has 18 decimals; the USDC ERC-20 interface has 6.
    uint256 internal constant NATIVE_PER_QUOTE = 1e12;
    uint24 public constant POOL_FEE_TIER = 10_000;
    uint160 internal constant MIN_SQRT_RATIO = 4295128739;
    uint160 internal constant MAX_SQRT_RATIO = 1461446703485210103287273052203988822378723970342;

    IUniswapV3FactoryCore public immutable uniswapFactory;
    /// @notice Native USDC through its ERC-20 interface.
    address public immutable quoteNative;

    address private _expectedPool;

    event Bought(address indexed token, address indexed buyer, uint256 nativeIn, uint256 tokensOut);
    event Sold(address indexed token, address indexed seller, uint256 tokensIn, uint256 nativeOut);

    constructor(IUniswapV3FactoryCore uniswapFactory_, address quoteNative_) {
        uniswapFactory = uniswapFactory_;
        quoteNative = quoteNative_;
    }

    /// @notice Buy `token` with native USDC. `minOut` is in token wei (18d).
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 out) {
        uint256 quoteIn = msg.value / NATIVE_PER_QUOTE;
        if (quoteIn == 0) revert ZeroAmount();

        IUniswapV3PoolCore pool = _pool(token);
        bool zeroForOne = quoteNative < token; // quote in -> token out
        _expectedPool = address(pool);
        (int256 a0, int256 a1) = pool.swap(
            msg.sender,
            zeroForOne,
            int256(quoteIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _expectedPool = address(0);

        out = uint256(-(zeroForOne ? a1 : a0));
        if (out < minOut) revert SlippageExceeded();
        emit Bought(token, msg.sender, msg.value, out);
    }

    /// @notice Sell `amountIn` of `token` (18d) for native USDC. `minOut` is
    ///         in native wei (18d). Requires prior token approval.
    function sell(address token, uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        if (amountIn == 0) revert ZeroAmount();
        IERC20(token).safeTransferFrom(msg.sender, address(this), amountIn);

        IUniswapV3PoolCore pool = _pool(token);
        bool zeroForOne = token < quoteNative; // token in -> quote out
        _expectedPool = address(pool);
        (int256 a0, int256 a1) = pool.swap(
            address(this),
            zeroForOne,
            int256(amountIn),
            zeroForOne ? MIN_SQRT_RATIO + 1 : MAX_SQRT_RATIO - 1,
            ""
        );
        _expectedPool = address(0);

        uint256 quoteOut = uint256(-(zeroForOne ? a1 : a0));
        out = quoteOut * NATIVE_PER_QUOTE;
        if (out < minOut) revert SlippageExceeded();
        (bool ok,) = msg.sender.call{value: out}("");
        if (!ok) revert NativeTransferFailed();
        emit Sold(token, msg.sender, amountIn, out);
    }

    /// @notice Pool swap callback: pay what the pool is owed. The quote side
    ///         is paid through the native USDC interface from this contract's
    ///         balance; the token side from tokens pulled before the swap.
    function uniswapV3SwapCallback(int256 amount0Delta, int256 amount1Delta, bytes calldata) external {
        if (msg.sender != _expectedPool) revert NotPool();
        if (amount0Delta > 0) {
            IERC20(IUniswapV3PoolCore(msg.sender).token0()).safeTransfer(msg.sender, uint256(amount0Delta));
        }
        if (amount1Delta > 0) {
            IERC20(IUniswapV3PoolCore(msg.sender).token1()).safeTransfer(msg.sender, uint256(amount1Delta));
        }
    }

    function _pool(address token) internal view returns (IUniswapV3PoolCore) {
        address pool = uniswapFactory.getPool(token, quoteNative, POOL_FEE_TIER);
        if (pool == address(0)) revert PoolMissing();
        return IUniswapV3PoolCore(pool);
    }

    /// @dev Receives native from quote transfers (pool payouts) and buy dust.
    receive() external payable {}
}
