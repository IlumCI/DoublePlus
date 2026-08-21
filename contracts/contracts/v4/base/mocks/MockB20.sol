// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

import {IB20FactoryMin} from "../IB20Min.sol";

/// @notice Test stand-in for a B-20 token: plain ERC20 plus the role subset
///         the launchpad exercises (admin, mint, burn, renounceLastAdmin).
///         Real B-20s are Rust precompiles that cannot run under a hardhat
///         fork, so fork tests wire the factory to this mock instead.
contract MockB20 is ERC20 {
    bytes32 public constant MINT_ROLE = keccak256("MINT_ROLE");
    bytes32 public constant BURN_ROLE = keccak256("BURN_ROLE");
    bytes32 public constant DEFAULT_ADMIN_ROLE = 0x00;

    mapping(bytes32 => mapping(address => bool)) public hasRole;
    address public admin;
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, address initialAdmin_, uint8 decimals_)
        ERC20(name_, symbol_)
    {
        admin = initialAdmin_;
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    modifier onlyAdmin() {
        require(msg.sender == admin, "not admin");
        _;
    }

    function grantRole(bytes32 role, address account) external onlyAdmin {
        hasRole[role][account] = true;
    }

    function revokeRole(bytes32 role, address account) external onlyAdmin {
        hasRole[role][account] = false;
    }

    function renounceLastAdmin() external onlyAdmin {
        admin = address(0);
    }

    function mint(address to, uint256 amount) external {
        require(hasRole[MINT_ROLE][msg.sender], "no mint role");
        _mint(to, amount);
    }

    function burn(uint256 amount) external {
        require(hasRole[BURN_ROLE][msg.sender], "no burn role");
        _burn(msg.sender, amount);
    }
}

/// @notice Test stand-in for the B20Factory precompile: same createB20 shape,
///         deploys a MockB20 via CREATE2 so addresses stay deterministic.
contract MockB20Factory is IB20FactoryMin {
    function createB20(B20Variant variant, bytes32 salt, bytes calldata params, bytes[] calldata)
        external
        payable
        returns (address token)
    {
        require(variant == B20Variant.ASSET, "mock: asset only");
        B20AssetCreateParams memory p = abi.decode(params, (B20AssetCreateParams));
        require(p.version == 1, "mock: version");
        token = address(
            new MockB20{salt: keccak256(abi.encode(msg.sender, salt))}(p.name, p.symbol, p.initialAdmin, p.decimals)
        );
    }

    function getB20Address(B20Variant, address, bytes32) external pure returns (address) {
        return address(0);
    }

    function isB20(address) external pure returns (bool) {
        return true;
    }

    function isB20Initialized(address) external pure returns (bool) {
        return true;
    }
}
