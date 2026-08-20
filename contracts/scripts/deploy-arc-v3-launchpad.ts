/**
 * Deploy the arcx V3 launchpad to Arc mainnet: TokenDeployer +
 * ArcLaunchpadFactory + ArcSwapRouter, targeting the DyorSwap V3 factory so
 * every launch pool is visible to the bots that index it.
 *
 * Run:
 *   set -a && source .env.deployer && set +a
 *   ROBINHOOD_RPC_URL=<arc rpc> ROBINHOOD_CHAIN_ID=5042 \
 *   npx hardhat run scripts/deploy-arc-v3-launchpad.ts --network robinhood
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const DYOR_FACTORY = "0xF0Db7b58379503491d857DB50Ac9ECE64C653918";
const QUOTE_NATIVE = "0x3600000000000000000000000000000000000000"; // native USDC ERC-20 interface
const OWNER = process.env.NEW_OWNER ?? "0x5dddea56774f01fc9d207bbd7b7633596a2f4a0b";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log(`deployer ${deployer.address} | chain ${net.chainId} | balance ${ethers.formatEther(bal)} USDC`);

  const dyor = ethers.getAddress(DYOR_FACTORY.toLowerCase());

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).deploy();
  await tokenDeployer.waitForDeployment();
  console.log("TokenDeployer:", await tokenDeployer.getAddress());

  const factory = await (
    await ethers.getContractFactory("ArcLaunchpadFactory")
  ).deploy(OWNER, OWNER, await tokenDeployer.getAddress(), dyor, QUOTE_NATIVE);
  await factory.waitForDeployment();
  console.log("ArcLaunchpadFactory:", await factory.getAddress());

  await (await tokenDeployer.setFactory(await factory.getAddress())).wait();
  console.log("tokenDeployer.factory set");

  const router = await (await ethers.getContractFactory("ArcSwapRouter")).deploy(dyor, QUOTE_NATIVE);
  await router.waitForDeployment();
  console.log("ArcSwapRouter:", await router.getAddress());

  const block = await ethers.provider.getBlockNumber();
  const record = {
    network: "arc",
    chainId: Number(net.chainId),
    deployer: deployer.address,
    owner: OWNER,
    timestamp: new Date().toISOString(),
    startBlock: block,
    dyorV3Factory: dyor,
    quoteNative: QUOTE_NATIVE,
    tokenDeployer: await tokenDeployer.getAddress(),
    factory: await factory.getAddress(),
    swapRouter: await router.getAddress(),
    poolFeeTier: 10000,
  };
  const out = path.join(__dirname, "..", "deployments", "arc-v3-launchpad.json");
  fs.writeFileSync(out, JSON.stringify(record, null, 2) + "\n");
  console.log("saved", out);

  const remaining = await ethers.provider.getBalance(deployer.address);
  console.log("remaining gas balance:", ethers.formatEther(remaining), "USDC");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
