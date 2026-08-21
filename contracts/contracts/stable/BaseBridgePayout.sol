// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title BaseBridgePayout
/// @author arcx.fun
/// @notice Base-side payout leg of the Arc -> Base bridge (bridge out). A user
///         sends native USDC on Arc to the relayer; the relayer verifies that
///         deposit off-chain and pays ERC-20 USDC here on Base to the same
///         address, keyed by the Arc transaction hash so each deposit pays out
///         exactly once. The relayer pre-approves this contract to move its
///         USDC float; no funds are custodied by the contract itself.
contract BaseBridgePayout {
    using SafeERC20 for IERC20;

    address public immutable relayer;
    IERC20 public immutable usdc;
    mapping(bytes32 arcTxHash => bool) public paid;

    event PaidOut(bytes32 indexed arcTxHash, address indexed to, uint256 amount);

    error NotRelayer();
    error AlreadyPaid();
    error ZeroAmount();

    constructor(address relayer_, address usdc_) {
        relayer = relayer_;
        usdc = IERC20(usdc_);
    }

    /// @notice Pay `to` `amount` USDC (6d) on Base for a verified Arc deposit.
    ///         Pulls from the relayer's balance via its prior approval.
    function payout(bytes32 arcTxHash, address to, uint256 amount) external {
        if (msg.sender != relayer) revert NotRelayer();
        if (paid[arcTxHash]) revert AlreadyPaid();
        if (amount == 0) revert ZeroAmount();
        paid[arcTxHash] = true;
        usdc.safeTransferFrom(relayer, to, amount);
        emit PaidOut(arcTxHash, to, amount);
    }
}
