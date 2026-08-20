// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title LaunchpadERC20
/// @notice Minimal fixed-supply token minted by the launchpad. It carries only
///         token logic: the ERC-20 itself, immutable attribution of its
///         creator, and an off-chain metadata pointer. It has no transfer
///         restrictions, no knowledge of its liquidity position, and no
///         administrative surface.
///
///         Ownership is renounced in the constructor, so `owner()` is the zero
///         address from the moment the token exists; there is nothing an owner
///         could call in any case.
contract LaunchpadERC20 is ERC20, Ownable {
    /// @notice Wallet credited as the token's creator. Set once at deployment
    ///         and never spoofable — forwarded by the factory from the launcher.
    address public immutable creator;

    string private _metadataURI;

    constructor(
        string memory name_,
        string memory symbol_,
        string memory metadataURI_,
        uint256 supply_,
        address creator_,
        address supplyRecipient_
    ) ERC20(name_, symbol_) Ownable(msg.sender) {
        creator = creator_;
        _metadataURI = metadataURI_;
        _mint(supplyRecipient_, supply_);
        // Appear ownerless immediately, using the standard Ownable model.
        _transferOwnership(address(0));
    }

    /// @notice Off-chain metadata JSON (description, logo, website, socials).
    function metadataURI() external view returns (string memory) {
        return _metadataURI;
    }
}
