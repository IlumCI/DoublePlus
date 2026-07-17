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

interface IWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @title QuiverRouter
/// @notice Native-ETH trading front door for Quiver V4 pools. Buyers send ETH,
///         which the router wraps to WETH and swaps for the token; sellers send
///         the token and receive ETH. The per-pool tax is applied automatically
///         by the hook during the swap. Stateless and permissionless.
contract QuiverRouter is IUnlockCallback, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;
    IWETH public immutable weth;
    address public immutable hook;
    uint24 public constant LP_FEE = 0;
    int24 public constant TICK_SPACING = 60;

    struct Order {
        PoolKey key;
        bool zeroForOne;
        uint256 amountIn;
        address recipient;
        bool payerIsSelf; // true when the router already holds the input (WETH buy)
        address payer;
    }

    error TooLittleReceived();

    constructor(IPoolManager pm, IWETH weth_, address hook_) {
        poolManager = pm;
        weth = weth_;
        hook = hook_;
    }

    function _key(address token) internal view returns (PoolKey memory key, bool tokenIsC0) {
        tokenIsC0 = token < address(weth);
        key = PoolKey({
            currency0: Currency.wrap(tokenIsC0 ? token : address(weth)),
            currency1: Currency.wrap(tokenIsC0 ? address(weth) : token),
            fee: LP_FEE,
            tickSpacing: TICK_SPACING,
            hooks: IHooks(hook)
        });
    }

    /// @notice Buy `token` with the ETH sent; output goes to the caller.
    function buy(address token, uint256 minOut) external payable nonReentrant returns (uint256 out) {
        require(msg.value > 0, "no eth");
        weth.deposit{value: msg.value}();
        (PoolKey memory key, bool tokenIsC0) = _key(token);
        // Spend WETH -> receive token. WETH is the non-token side.
        bool zeroForOne = !tokenIsC0; // WETH is currency0 when token is currency1
        bytes memory res = poolManager.unlock(
            abi.encode(Order(key, zeroForOne, msg.value, msg.sender, true, address(this)))
        );
        out = abi.decode(res, (uint256));
        if (out < minOut) revert TooLittleReceived();
    }

    /// @notice Sell `amountIn` of `token` for ETH; ETH goes to the caller.
    function sell(address token, uint256 amountIn, uint256 minOut) external nonReentrant returns (uint256 out) {
        require(amountIn > 0, "no amount");
        (PoolKey memory key, bool tokenIsC0) = _key(token);
        // Spend token -> receive WETH. token side depends on orientation.
        bool zeroForOne = tokenIsC0; // token is currency0 -> zeroForOne
        bytes memory res = poolManager.unlock(
            abi.encode(Order(key, zeroForOne, amountIn, address(this), false, msg.sender))
        );
        out = abi.decode(res, (uint256));
        if (out < minOut) revert TooLittleReceived();
        weth.withdraw(out);
        (bool ok, ) = payable(msg.sender).call{value: out}("");
        require(ok, "eth xfer");
    }

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pm");
        Order memory o = abi.decode(raw, (Order));

        BalanceDelta delta = poolManager.swap(
            o.key,
            SwapParams({
                zeroForOne: o.zeroForOne,
                amountSpecified: -int256(o.amountIn),
                sqrtPriceLimitX96: o.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        Currency inC = o.zeroForOne ? o.key.currency0 : o.key.currency1;
        Currency outC = o.zeroForOne ? o.key.currency1 : o.key.currency0;
        int128 inDelta = o.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outDelta = o.zeroForOne ? delta.amount1() : delta.amount0();

        // Pay the input.
        uint256 owed = uint256(uint128(-inDelta));
        poolManager.sync(inC);
        if (o.payerIsSelf) {
            IERC20(Currency.unwrap(inC)).safeTransfer(address(poolManager), owed);
        } else {
            IERC20(Currency.unwrap(inC)).safeTransferFrom(o.payer, address(poolManager), owed);
        }
        poolManager.settle();

        // Take the output.
        uint256 out = uint256(uint128(outDelta));
        poolManager.take(outC, o.recipient, out);
        return abi.encode(out);
    }

    receive() external payable {
        require(msg.sender == address(weth), "direct eth");
    }
}
