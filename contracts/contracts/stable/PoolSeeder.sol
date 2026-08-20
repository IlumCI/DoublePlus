// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

interface IV3FactoryMinimal {
    function getPool(address, address, uint24) external view returns (address);
    function createPool(address, address, uint24) external returns (address);
}

interface IV3PoolMinimal {
    function initialize(uint160 sqrtPriceX96) external;
    function slot0()
        external
        view
        returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool);
    function mint(address recipient, int24 tickLower, int24 tickUpper, uint128 amount, bytes calldata data)
        external
        returns (uint256 amount0, uint256 amount1);
    function burn(int24 tickLower, int24 tickUpper, uint128 amount) external returns (uint256, uint256);
    function collect(address recipient, int24 tickLower, int24 tickUpper, uint128 amount0Requested, uint128 amount1Requested)
        external
        returns (uint128, uint128);
    function token0() external view returns (address);
    function token1() external view returns (address);
}

/// @notice Owner-operated helper that creates, initializes and seeds a
///         liquidity position on any Uniswap V3-style pool directly through
///         the core contracts, with no periphery dependency. Fund it with the
///         tokens first; the mint callback pays the pool from this balance.
contract PoolSeeder {
    using SafeERC20 for IERC20;

    address public immutable owner;

    error NotOwner();
    error NotPool();

    address private expectedPool;

    constructor(address owner_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function seed(
        address factory,
        address tokenA,
        address tokenB,
        uint24 fee,
        uint160 sqrtPriceX96,
        int24 tickLower,
        int24 tickUpper,
        uint128 liquidity
    ) external onlyOwner returns (address pool) {
        (address t0, address t1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        pool = IV3FactoryMinimal(factory).getPool(t0, t1, fee);
        if (pool == address(0)) pool = IV3FactoryMinimal(factory).createPool(t0, t1, fee);
        (uint160 current,,,,,,) = IV3PoolMinimal(pool).slot0();
        if (current == 0) IV3PoolMinimal(pool).initialize(sqrtPriceX96);
        expectedPool = pool;
        IV3PoolMinimal(pool).mint(address(this), tickLower, tickUpper, liquidity, "");
        expectedPool = address(0);
    }

    function uniswapV3MintCallback(uint256 amount0Owed, uint256 amount1Owed, bytes calldata) external {
        if (msg.sender != expectedPool) revert NotPool();
        if (amount0Owed > 0) IERC20(IV3PoolMinimal(msg.sender).token0()).safeTransfer(msg.sender, amount0Owed);
        if (amount1Owed > 0) IERC20(IV3PoolMinimal(msg.sender).token1()).safeTransfer(msg.sender, amount1Owed);
    }

    /// @notice Poke and collect accrued fees (or withdrawn principal) for a
    ///         position this contract holds.
    function collect(address pool, int24 tickLower, int24 tickUpper) external onlyOwner returns (uint128 a0, uint128 a1) {
        IV3PoolMinimal(pool).burn(tickLower, tickUpper, 0);
        (a0, a1) = IV3PoolMinimal(pool).collect(owner, tickLower, tickUpper, type(uint128).max, type(uint128).max);
    }

    /// @notice Remove liquidity and send everything to the owner.
    function unwind(address pool, int24 tickLower, int24 tickUpper, uint128 liquidity) external onlyOwner {
        IV3PoolMinimal(pool).burn(tickLower, tickUpper, liquidity);
        IV3PoolMinimal(pool).collect(owner, tickLower, tickUpper, type(uint128).max, type(uint128).max);
    }

    /// @notice Recover any token balance parked here.
    function sweep(address token, address to) external onlyOwner {
        IERC20 t = IERC20(token);
        t.safeTransfer(to, t.balanceOf(address(this)));
    }
}
