// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ArcBridgePayout
/// @author arcx.fun
/// @notice Payout leg of the instant Base -> Arc bridge. The relayer verifies
///         a USDC deposit on Base off-chain, then pays native USDC here with
///         the Base transaction hash as a receipt. The mapping makes each
///         deposit claimable exactly once, with the ledger readable on-chain.
contract ArcBridgePayout {
    address public immutable relayer;
    mapping(bytes32 baseTxHash => bool) public paid;

    event Paid(bytes32 indexed baseTxHash, address indexed to, uint256 amount);

    error NotRelayer();
    error AlreadyPaid();
    error SendFailed();
    error ZeroAmount();

    constructor(address relayer_) {
        relayer = relayer_;
    }

    /// @notice Pay `to` the attached native USDC for a verified Base deposit.
    function payout(bytes32 baseTxHash, address to) external payable {
        if (msg.sender != relayer) revert NotRelayer();
        if (paid[baseTxHash]) revert AlreadyPaid();
        if (msg.value == 0) revert ZeroAmount();
        paid[baseTxHash] = true;
        (bool ok, ) = to.call{value: msg.value}("");
        if (!ok) revert SendFailed();
        emit Paid(baseTxHash, to, msg.value);
    }
}
