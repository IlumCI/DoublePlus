import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Deploys the launchpad protocol to the configured network.
 *
 * Roles are independent and enforced on-chain:
 *   - Deployer (PRIVATE_KEY, from .env.deployer): signs the deployment only.
 *     It receives no protocol privileges of any kind.
 *   - Protocol admin (PROTOCOL_ADMIN): an immutable address, distinct from the
 *     deployer, baked into the factory at construction. It is the only wallet
 *     that can pause launches, manage held positions, and claim the protocol
 *     fee share. Ideally a team multisig.
 *   - Token creators: attributed per token; they pull only their own fees.
 *
 * Required environment:
 *   UNISWAP_V3_FACTORY       Canonical Uniswap V3 factory
 *   UNISWAP_POSITION_MANAGER NonfungiblePositionManager
 *   UNISWAP_SWAP_ROUTER      SwapRouter (V3 / SwapRouter02)
 *   WETH_ADDRESS             Wrapped native token
 *   ETH_USD_PRICE_8          Native/USD price, 8 decimals (initial pool sizing)
 *   PROTOCOL_ADMIN           Immutable admin wallet (must NOT be the deployer)
 * Optional:
 *   PRICE_FEED               Chainlink-compatible native/USD aggregator; set by
 *                            the protocol admin after deployment.
 */
async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying to ${network.name} as ${deployer.address}`);

  const required = [
    "UNISWAP_V3_FACTORY",
    "UNISWAP_POSITION_MANAGER",
    "UNISWAP_SWAP_ROUTER",
    "WETH_ADDRESS",
    "ETH_USD_PRICE_8",
    "PROTOCOL_ADMIN",
  ];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing env var ${key}`);
  }

  const protocolAdmin = process.env.PROTOCOL_ADMIN!;
  if (!ethers.isAddress(protocolAdmin)) throw new Error("PROTOCOL_ADMIN is not a valid address");
  if (protocolAdmin.toLowerCase() === deployer.address.toLowerCase()) {
    throw new Error("PROTOCOL_ADMIN must be a different wallet from the deployer");
  }

  const nativeUsd8 = BigInt(process.env.ETH_USD_PRICE_8!);

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  console.log(`TokenDeployer:    ${await tokenDeployer.getAddress()}`);

  const factory = await (await ethers.getContractFactory("LaunchpadFactory")).deploy(
    protocolAdmin,
    await tokenDeployer.getAddress(),
    process.env.UNISWAP_V3_FACTORY!,
    process.env.UNISWAP_POSITION_MANAGER!,
    process.env.UNISWAP_SWAP_ROUTER!,
    process.env.WETH_ADDRESS!,
    nativeUsd8
  );
  await factory.waitForDeployment();
  console.log(`LaunchpadFactory: ${await factory.getAddress()}`);

  await (await tokenDeployer.setFactory(await factory.getAddress())).wait();
  console.log("TokenDeployer wired to LaunchpadFactory");

  // Sanity: the deployer holds no privileges; the admin is the configured wallet.
  const onChainAdmin = await factory.protocolAdmin();
  if (onChainAdmin.toLowerCase() !== protocolAdmin.toLowerCase()) {
    throw new Error("Protocol admin mismatch after deployment");
  }
  console.log(`Protocol admin (immutable): ${onChainAdmin}`);
  console.log("Deployer holds zero protocol privileges.");
  if (process.env.PRICE_FEED) {
    console.log(
      `Reminder: have the protocol admin call setPriceFeed(${process.env.PRICE_FEED}); ` +
        "the deployer cannot set it."
    );
  }

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: deployer.address,
    protocolAdmin,
    timestamp: new Date().toISOString(),
    contracts: {
      tokenDeployer: await tokenDeployer.getAddress(),
      factory: await factory.getAddress(),
    },
    uniswap: {
      factory: process.env.UNISWAP_V3_FACTORY,
      positionManager: process.env.UNISWAP_POSITION_MANAGER,
      swapRouter: process.env.UNISWAP_SWAP_ROUTER,
      weth: process.env.WETH_ADDRESS,
    },
  };

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${network.name}.json`);
  fs.writeFileSync(outFile, JSON.stringify(deployment, null, 2));
  console.log(`Deployment written to ${outFile}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
