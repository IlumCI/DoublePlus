import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import UniswapV3FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import SwapRouterArtifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
import PositionManagerArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * Deploys a protocol-owned Uniswap V3 stack (WETH9, factory, swap router,
 * position manager) from the canonical build artifacts. Used on chains where
 * no adopted canonical Uniswap V3 deployment exists yet, so the launchpad
 * never depends on third-party infrastructure of unknown provenance.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Deploying Uniswap V3 stack to ${network.name} as ${deployer.address}`);
  console.log(`Deployer balance: ${ethers.formatEther(balance)} ETH`);

  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  await weth.waitForDeployment();
  console.log(`WETH9:                      ${await weth.getAddress()}`);

  const factory = await new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    deployer
  ).deploy();
  await factory.waitForDeployment();
  console.log(`UniswapV3Factory:           ${await factory.getAddress()}`);

  const positionManager = await new ethers.ContractFactory(
    PositionManagerArtifact.abi,
    PositionManagerArtifact.bytecode,
    deployer
  ).deploy(await factory.getAddress(), await weth.getAddress(), ethers.ZeroAddress);
  await positionManager.waitForDeployment();
  console.log(`NonfungiblePositionManager: ${await positionManager.getAddress()}`);

  const swapRouter = await new ethers.ContractFactory(
    SwapRouterArtifact.abi,
    SwapRouterArtifact.bytecode,
    deployer
  ).deploy(
    ethers.ZeroAddress,
    await factory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress()
  );
  await swapRouter.waitForDeployment();
  console.log(`SwapRouter02:               ${await swapRouter.getAddress()}`);

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log(`Remaining balance: ${ethers.formatEther(remaining)} ETH`);

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    timestamp: new Date().toISOString(),
    weth: await weth.getAddress(),
    factory: await factory.getAddress(),
    swapRouter: await swapRouter.getAddress(),
    positionManager: await positionManager.getAddress(),
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const file = path.join(outDir, `${network.name}-uniswap.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Written to ${file}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
