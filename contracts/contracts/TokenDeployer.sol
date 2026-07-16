// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {LaunchpadERC20} from "./LaunchpadERC20.sol";
import {ProtocolConfig} from "./libraries/ProtocolConfig.sol";

/// @title TokenDeployer
/// @notice Deploys token instances on behalf of the launchpad factory. Kept as
///         a separate unit so the token creation code lives outside the factory
///         bytecode, and so token deployment stays gated to a single caller.
///
///         The factory is bound once, by the deployer, immediately after both
///         contracts exist. Thereafter only the factory can mint tokens, and
///         the full supply is always minted to the factory for pool seeding.
contract TokenDeployer {
    error NotFactory();
    error FactoryAlreadySet();
    error NotDeployer();
    error ZeroAddress();

    event FactorySet(address indexed factory);
    event TokenDeployed(address indexed token, address indexed creator);

    /// @notice The launchpad factory allowed to deploy tokens.
    address public factory;
    address private immutable _deployer;

    constructor() {
        _deployer = msg.sender;
    }

    /// @notice One-time wiring by the original deployer.
    function setFactory(address factory_) external {
        if (msg.sender != _deployer) revert NotDeployer();
        if (factory != address(0)) revert FactoryAlreadySet();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
        emit FactorySet(factory_);
    }

    /// @notice Deploy a fixed-supply token, minting the full supply to the
    ///         factory (`msg.sender`) for pool seeding, while attributing the
    ///         real launcher as the creator.
    function deploy(
        address creator,
        string calldata name,
        string calldata symbol,
        string calldata metadataURI
    ) external returns (address token) {
        if (msg.sender != factory) revert NotFactory();
        token = address(
            new LaunchpadERC20(
                name,
                symbol,
                metadataURI,
                ProtocolConfig.TOTAL_SUPPLY,
                creator,
                msg.sender
            )
        );
        emit TokenDeployed(token, creator);
    }
}
