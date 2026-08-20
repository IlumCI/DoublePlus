// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {DiamondToken} from "./DiamondToken.sol";

/// @title DiamondTokenDeployer
/// @notice Deploys DiamondToken instances for the factory. Split out so the
///         factory stays under the contract size limit; only the factory can
///         call, supply always mints to the factory, and the factory keeps
///         the one-time initHook authority.
contract DiamondTokenDeployer {
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
            new DiamondToken{salt: salt}(
                name_, symbol_, metadataURI_, supply_, creator_, factory, taxBps_, rewardToken_, factory
            )
        );
    }
}
