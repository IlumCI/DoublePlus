// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

interface IVentureRouterFor {
    function buyFor(address coin, bytes calldata v3Path, uint256 minCoinOut, address trader)
        external
        payable
        returns (uint256 coinOut);
    function sellFor(address coin, uint256 amountIn, bytes calldata v3PathReverse, uint256 minEthOut, address trader)
        external
        returns (uint256 ethOut);
}

/// @title VentureLimitOrders
/// @notice Escrowed limit orders on graduated ventures. A buy escrows ETH and
///         names the fewest coins it will take for it; a sell escrows coins and
///         names the least ETH. Anyone may fill an order once the pool can meet
///         it: the fill runs through the router with the owner's floor as the
///         slippage bound, so a filler can never hand the owner a worse price
///         than they asked for, however the pool was pushed. The filler keeps
///         the owner's chosen tip out of the proceeds, which is what pays a
///         keeper to watch.
contract VentureLimitOrders is ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint16 public constant MAX_TIP_BPS = 100;

    struct Order {
        address owner;
        address coin;
        bool isBuy;
        uint16 tipBps;
        uint64 expiry; // 0 = good until cancelled
        uint256 amountIn; // ETH for a buy, coin for a sell
        uint256 minOut; // the owner's floor, after the tip
    }

    IVentureRouterFor public immutable router;
    Order[] internal _orders;

    event Placed(uint256 indexed id, address indexed owner, address indexed coin, bool isBuy, uint256 amountIn, uint256 minOut, uint16 tipBps, uint64 expiry);
    event Filled(uint256 indexed id, address indexed filler, uint256 out, uint256 tip);
    event Cancelled(uint256 indexed id);

    error BadOrder();
    error NotOwner();
    error Closed();
    error BelowFloor();

    constructor(IVentureRouterFor router_) {
        router = router_;
    }

    receive() external payable {
        if (msg.sender != address(router)) revert BadOrder();
    }

    /// @param amountIn for a sell, the coins to escrow; ignored for a buy
    ///        (msg.value is the escrow).
    function place(address coin, bool isBuy, uint256 amountIn, uint256 minOut, uint16 tipBps, uint64 expiry)
        external
        payable
        nonReentrant
        returns (uint256 id)
    {
        if (isBuy) amountIn = msg.value;
        else if (msg.value != 0) revert BadOrder();
        if (amountIn == 0 || minOut == 0 || tipBps > MAX_TIP_BPS) revert BadOrder();
        if (expiry != 0 && expiry <= block.timestamp) revert BadOrder();
        if (!isBuy) {
            // Measure what arrived, so a fee-on-transfer coin can't overstate the escrow.
            uint256 before = IERC20(coin).balanceOf(address(this));
            IERC20(coin).safeTransferFrom(msg.sender, address(this), amountIn);
            amountIn = IERC20(coin).balanceOf(address(this)) - before;
        }
        id = _orders.length;
        _orders.push(Order(msg.sender, coin, isBuy, tipBps, expiry, amountIn, minOut));
        emit Placed(id, msg.sender, coin, isBuy, amountIn, minOut, tipBps, expiry);
    }

    function cancel(uint256 id) external nonReentrant {
        Order memory o = _orders[id];
        if (o.owner != msg.sender) revert NotOwner();
        if (o.amountIn == 0) revert Closed();
        _orders[id].amountIn = 0;
        _send(o.isBuy ? address(0) : o.coin, o.owner, o.amountIn);
        emit Cancelled(id);
    }

    /// @notice Fill an order whole. Reverts unless the owner nets at least
    ///         their floor after the tip; expired orders refund their owner.
    function fill(uint256 id) external nonReentrant returns (uint256 out) {
        Order memory o = _orders[id];
        if (o.amountIn == 0) revert Closed();
        _orders[id].amountIn = 0;
        if (o.expiry != 0 && block.timestamp > o.expiry) {
            _send(o.isBuy ? address(0) : o.coin, o.owner, o.amountIn);
            emit Cancelled(id);
            return 0;
        }
        // The floor including the tip: the owner's share must still clear minOut.
        uint256 gross = (o.minOut * 10_000 + (10_000 - o.tipBps) - 1) / (10_000 - o.tipBps);
        if (o.isBuy) {
            out = router.buyFor{value: o.amountIn}(o.coin, "", gross, o.owner);
        } else {
            IERC20(o.coin).forceApprove(address(router), o.amountIn);
            out = router.sellFor(o.coin, o.amountIn, "", gross, o.owner);
        }
        uint256 tip = (out * o.tipBps) / 10_000;
        if (out - tip < o.minOut) revert BelowFloor();
        address asset = o.isBuy ? o.coin : address(0);
        _send(asset, o.owner, out - tip);
        _send(asset, msg.sender, tip);
        emit Filled(id, msg.sender, out, tip);
    }

    function order(uint256 id) external view returns (Order memory) {
        return _orders[id];
    }

    function totalOrders() external view returns (uint256) {
        return _orders.length;
    }

    function _send(address asset, address to, uint256 amount) private {
        if (amount == 0) return;
        if (asset == address(0)) {
            (bool ok,) = payable(to).call{value: amount}("");
            if (!ok) revert BadOrder();
        } else {
            IERC20(asset).safeTransfer(to, amount);
        }
    }
}
