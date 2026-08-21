// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title FlyToken
/// @notice A deliberately boring launchpad token: fixed supply, no transfer
///         hooks, no exclusion lists, no post-deploy wiring, no owner. All
///         economics (fees, splits, buybacks, trader rewards) live in the
///         pool hook, so the token itself is a vanilla ERC-20 that any
///         security scanner reads clean. Only extras: on-chain metadata,
///         an immutable creator attribution, and a public burn.
contract FlyToken is ERC20 {
    /// @notice Wallet credited as the token's creator (immutable attribution).
    address public immutable creator;

    string private _metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        uint256 supply_,
        address creator_,
        address supplyRecipient_
    ) ERC20(name_, symbol_) {
        creator = creator_;
        _metadataURI = metadataURI_;
        _mint(supplyRecipient_, supply_);
    }

    /// @notice Off-chain metadata JSON (description, logo, website, socials).
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }

    /// @notice Burn tokens held by the caller (buyback-and-burn endpoint).
    function burn(uint256 amount) external {
        _burn(msg.sender, amount);
    }
}
