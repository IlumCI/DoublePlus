// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {IUnlockCallback} from "@uniswap/v4-core/src/interfaces/callback/IUnlockCallback.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";
import {Currency} from "@uniswap/v4-core/src/types/Currency.sol";
import {BalanceDelta} from "@uniswap/v4-core/src/types/BalanceDelta.sol";
import {SwapParams} from "@uniswap/v4-core/src/types/PoolOperation.sol";
import {TickMath} from "@uniswap/v4-core/src/libraries/TickMath.sol";

/// @dev Minimal exact-input swap router for tests. Pulls the input ERC-20 from
///      the caller, swaps through the PoolManager, and forwards the output.
contract TestRouter is IUnlockCallback {
    using SafeERC20 for IERC20;

    IPoolManager public immutable poolManager;

    struct Data {
        PoolKey key;
        bool zeroForOne;
        int256 amountSpecified; // negative = exact-input, positive = exact-output
        address payer;
        address recipient;
    }

    constructor(IPoolManager pm) {
        poolManager = pm;
    }

    function swapExactIn(PoolKey calldata key, bool zeroForOne, uint256 amountIn, address recipient)
        external
        returns (uint256 amountOut)
    {
        bytes memory res = poolManager.unlock(
            abi.encode(Data(key, zeroForOne, -int256(amountIn), msg.sender, recipient))
        );
        amountOut = abi.decode(res, (uint256));
    }

    function swapExactOut(PoolKey calldata key, bool zeroForOne, uint256 amountOut, address recipient)
        external
        returns (uint256 taken)
    {
        bytes memory res = poolManager.unlock(
            abi.encode(Data(key, zeroForOne, int256(amountOut), msg.sender, recipient))
        );
        taken = abi.decode(res, (uint256));
    }

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pm");
        Data memory d = abi.decode(raw, (Data));

        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: d.amountSpecified,
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        // Generic settle: pay any currency we owe, take any we're owed. Works for
        // exact-input and exact-output, and absorbs the hook's fee delta.
        uint256 out0 = _resolve(d.key.currency0, delta.amount0(), d.payer, d.recipient);
        uint256 out1 = _resolve(d.key.currency1, delta.amount1(), d.payer, d.recipient);
        return abi.encode(out0 + out1);
    }

    function _resolve(Currency c, int128 amount, address payer, address recipient) internal returns (uint256 taken) {
        if (amount < 0) {
            uint256 owed = uint256(uint128(-amount));
            poolManager.sync(c);
            IERC20(Currency.unwrap(c)).safeTransferFrom(payer, address(poolManager), owed);
            poolManager.settle();
        } else if (amount > 0) {
            taken = uint256(uint128(amount));
            poolManager.take(c, recipient, taken);
        }
    }
}
