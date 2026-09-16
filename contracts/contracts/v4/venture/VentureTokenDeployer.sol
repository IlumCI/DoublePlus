// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {QuiverToken} from "../QuiverToken.sol";

/// @title VentureTokenDeployer
/// @notice Deploys QuiverToken instances for the venture factory. Split out so
///         the factory stays under the contract size limit; only the factory
///         can call, supply always mints to the factory, and the factory keeps
///         the one-time initHook authority through the forwarder below
///         (QuiverToken grants that authority to its deployer).
contract VentureTokenDeployer {
    address public immutable factory;

    error OnlyFactory();

    constructor(address factory_) {
        factory = factory_;
    }

    function deployToken(
        bytes32 salt,
        string calldata name_,
        string calldata symbol_,
        string calldata metadataURI_,
        uint256 supply_,
        address creator_,
        uint16 taxBps_,
        address rewardToken_
    ) external returns (address token) {
        if (msg.sender != factory) revert OnlyFactory();
        token = address(
            new QuiverToken{salt: salt}(name_, symbol_, metadataURI_, supply_, creator_, factory, taxBps_, rewardToken_)
        );
    }

    function initHook(address token, address hook_, address[] calldata excludedAddrs) external {
        if (msg.sender != factory) revert OnlyFactory();
        QuiverToken(payable(token)).initHook(hook_, excludedAddrs);
    }
}
