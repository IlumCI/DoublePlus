// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @notice Minimal surface of Base's B20Factory precompile
///         (0xB20f0000...0000) used by the launchpad. Mirrors base-std's
///         IB20Factory for the ASSET variant only.
interface IB20FactoryMin {
    enum B20Variant {
        ASSET,
        STABLECOIN
    }

    /// @dev ABI-encoded into `params` with the leading version byte (currently 1).
    struct B20AssetCreateParams {
        uint8 version;
        string name;
        string symbol;
        address initialAdmin;
        uint8 decimals;
    }

    function createB20(B20Variant variant, bytes32 salt, bytes calldata params, bytes[] calldata initCalls)
        external
        payable
        returns (address token);

    function getB20Address(B20Variant variant, address sender, bytes32 salt) external view returns (address);

    function isB20(address token) external view returns (bool);

    function isB20Initialized(address token) external view returns (bool);
}

/// @notice Minimal B20 token surface the launchpad touches: role plumbing to
///         mint the fixed supply, hand the hook its burn power, and then seal
///         the token admin-less forever.
interface IB20TokenMin {
    function MINT_ROLE() external view returns (bytes32);

    function BURN_ROLE() external view returns (bytes32);

    function grantRole(bytes32 role, address account) external;

    function revokeRole(bytes32 role, address account) external;

    /// @dev Callable only by the sole remaining DEFAULT_ADMIN_ROLE holder.
    function renounceLastAdmin() external;

    function mint(address to, uint256 amount) external;

    function burn(uint256 amount) external;
}
