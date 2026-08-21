// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

import {IPoolManager} from "@uniswap/v4-core/src/interfaces/IPoolManager.sol";
import {PoolKey} from "@uniswap/v4-core/src/types/PoolKey.sol";

import {StockRewardVault} from "./StockRewardVault.sol";

/// @notice Isolates the StockRewardVault creation bytecode so the factory
///         stays under the contract-size limit. The factory calls `deploy`
///         once per launch to mint that coin's holder-reward vault.
contract RewardVaultDeployer {
    function deploy(
        IPoolManager poolManager,
        address coin,
        address stock,
        address keeper,
        PoolKey calldata key,
        bool coinIsCurrency0
    ) external returns (address vault) {
        vault = address(new StockRewardVault(poolManager, coin, stock, keeper, key, coinIsCurrency0));
    }
}
