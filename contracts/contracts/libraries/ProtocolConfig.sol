// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title ProtocolConfig
/// @notice Single source of truth for the launchpad's fixed protocol rules.
///         Every launch is deployed against these exact parameters, so nothing
///         here is caller-configurable and the on-chain accounting can never
///         disagree with what the UI promises.
library ProtocolConfig {
    /// @dev Basis-point denominator.
    uint16 internal constant BPS = 10_000;

    /// @notice Fixed supply minted for every token (18 decimals).
    uint256 internal constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Uniswap V3 fee tier every pool is created at (1%), so trades
    ///         routed directly against the pool pay the same rate as the app.
    uint24 internal constant POOL_FEE_TIER = 10_000;

    /// @notice Flat trading fee taken on app-routed buys and sells (1%).
    uint16 internal constant TRADE_FEE_BPS = 100;

    /// @notice Share of the trading fee that accrues to the token creator (80%).
    uint16 internal constant CREATOR_FEE_BPS = 8_000;

    /// @notice Share of the trading fee that accrues to the protocol (20%).
    uint16 internal constant PROTOCOL_FEE_BPS = 2_000;

    /// @notice Market cap (USD, 8 decimals) every token starts trading at.
    uint256 internal constant INITIAL_MARKET_CAP_USD = 2_000e8;
}
