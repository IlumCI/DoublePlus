// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Fee-split constants for the Base stock launchpad, forked from the
///         deployed AdvancedFeeHook model. The platform takes half of a pool's
///         trade tax, capped at 1% of volume; the rest is the creator share
///         that the hook splits into burn, liquidity, and payees.
library LaunchFees {
    uint256 internal constant BPS = 10_000;

    /// @dev Highest trade tax a pool may set: 10%.
    uint256 internal constant MAX_TAX_BPS = 1_000;

    /// @dev Platform never takes more than 1% of volume, regardless of tax.
    uint256 internal constant PLATFORM_CAP_BPS = 100;

    function platformCut(uint256 totalTaxBps) internal pure returns (uint256) {
        uint256 half = totalTaxBps / 2;
        return half < PLATFORM_CAP_BPS ? half : PLATFORM_CAP_BPS;
    }

    function allocatable(uint256 totalTaxBps) internal pure returns (uint256) {
        return totalTaxBps - platformCut(totalTaxBps);
    }
}
