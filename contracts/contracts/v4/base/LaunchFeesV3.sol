// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title LaunchFeesV3
/// @notice Fee schedule for the koi.fun V3 launch model: a flat trade tax with
///         NO platform cut. The whole tax is allocatable to the pool's payees,
///         which the factory configures 50/50 between the creator (feeRecipient)
///         and the holder-reward vault — so every trade is split 50% holders /
///         50% creator, with the platform taking nothing from trades.
library LaunchFeesV3 {
    uint256 internal constant BPS = 10_000;

    /// @dev Fixed trade tax: 2%.
    uint16 internal constant TAX_BPS = 200;

    /// @dev Cap kept for interface parity with the V2 hook; the tax may never
    ///      exceed this. Equal to TAX_BPS since the tax is fixed.
    uint256 internal constant MAX_TAX_BPS = 200;

    /// @dev The platform takes nothing from trades in the V3 model.
    function platformCut(uint256) internal pure returns (uint256) {
        return 0;
    }

    /// @dev Everything is allocatable to payees (no platform cut).
    function allocatable(uint256 totalTaxBps) internal pure returns (uint256) {
        return totalTaxBps;
    }
}
