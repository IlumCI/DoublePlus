// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IVentureListings} from "./VentureUpdates.sol";

/// @title VentureBoosts
/// @notice Paid placement for listed coins. Anyone can boost a coin for a
///         number of hours at a fixed price per hour; boosts on a live run
///         stack, extending the clock and adding to what the run has paid,
///         and the site pins the biggest live runs to the top of the board.
///         Every wei goes straight to the treasury. No admin: the price and
///         the treasury are fixed at deploy.
contract VentureBoosts is ReentrancyGuard {
    uint256 public constant MAX_HOURS = 168;

    IVentureListings public immutable factory;
    address public immutable treasury;
    uint256 public immutable pricePerHour;

    struct Boost {
        uint64 until;
        uint192 paid; // paid into the current run; resets once a run lapses
    }

    mapping(address coin => Boost) public boostOf;

    event Boosted(address indexed coin, address indexed by, uint256 hoursBought, uint256 paid, uint64 until);

    error NotListed();
    error BadHours();
    error WrongPayment();
    error PayFailed();

    constructor(IVentureListings factory_, address treasury_, uint256 pricePerHour_) {
        require(treasury_ != address(0) && pricePerHour_ > 0, "params");
        factory = factory_;
        treasury = treasury_;
        pricePerHour = pricePerHour_;
    }

    function boost(address coin, uint256 hoursBought) external payable nonReentrant {
        (address creator,,,,) = factory.listings(coin);
        if (creator == address(0)) revert NotListed();
        if (hoursBought == 0 || hoursBought > MAX_HOURS) revert BadHours();
        if (msg.value != hoursBought * pricePerHour) revert WrongPayment();
        Boost memory b = boostOf[coin];
        uint64 start = b.until > block.timestamp ? b.until : uint64(block.timestamp);
        if (b.until <= block.timestamp) b.paid = 0;
        b.until = start + uint64(hoursBought * 1 hours);
        b.paid += uint192(msg.value);
        boostOf[coin] = b;
        (bool ok,) = payable(treasury).call{value: msg.value}("");
        if (!ok) revert PayFailed();
        emit Boosted(coin, msg.sender, hoursBought, msg.value, b.until);
    }

    /// @notice A coin's live boost: when it ends and what the run has paid
    ///         (both zero once it has lapsed).
    function activeBoost(address coin) external view returns (uint64 until, uint256 paid) {
        Boost memory b = boostOf[coin];
        if (b.until <= block.timestamp) return (0, 0);
        return (b.until, b.paid);
    }
}
