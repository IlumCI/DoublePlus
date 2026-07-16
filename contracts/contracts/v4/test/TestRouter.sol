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
        uint256 amountIn;
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
            abi.encode(Data(key, zeroForOne, amountIn, msg.sender, recipient))
        );
        amountOut = abi.decode(res, (uint256));
    }

    function unlockCallback(bytes calldata raw) external override returns (bytes memory) {
        require(msg.sender == address(poolManager), "not pm");
        Data memory d = abi.decode(raw, (Data));

        BalanceDelta delta = poolManager.swap(
            d.key,
            SwapParams({
                zeroForOne: d.zeroForOne,
                amountSpecified: -int256(d.amountIn),
                sqrtPriceLimitX96: d.zeroForOne ? TickMath.MIN_SQRT_PRICE + 1 : TickMath.MAX_SQRT_PRICE - 1
            }),
            ""
        );

        Currency inC = d.zeroForOne ? d.key.currency0 : d.key.currency1;
        Currency outC = d.zeroForOne ? d.key.currency1 : d.key.currency0;
        int128 inDelta = d.zeroForOne ? delta.amount0() : delta.amount1();
        int128 outDelta = d.zeroForOne ? delta.amount1() : delta.amount0();

        // Pay input: pull from payer, settle to PoolManager.
        uint256 owed = uint256(uint128(-inDelta));
        poolManager.sync(inC);
        IERC20(Currency.unwrap(inC)).safeTransferFrom(d.payer, address(poolManager), owed);
        poolManager.settle();

        // Take output to the recipient.
        uint256 out = uint256(uint128(outDelta));
        poolManager.take(outC, d.recipient, out);

        return abi.encode(out);
    }
}
