/**
 * Deploy BaseBridgePayout on Base for the Arc -> Base bridge-out route.
 * Run:
 *   set -a && source .env.deployer && set +a
 *   ROBINHOOD_RPC_URL=https://mainnet.base.org ROBINHOOD_CHAIN_ID=8453 \
 *   npx hardhat run scripts/deploy-base-bridge-payout.ts --network robinhood
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const RELAYER = process.env.RELAYER_ADDRESS ?? "0xe5b498a00596ab2fa0e8a86cdde15502b2552208";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

async function main() {
  const [deployer] = await ethers.getSigners();
  const net = await ethers.provider.getNetwork();
  console.log("deployer:", deployer.address, "chain:", net.chainId.toString(), "ETH:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)));
  if (net.chainId !== 8453n) throw new Error("must run on Base (8453)");

  const c = await (await ethers.getContractFactory("BaseBridgePayout")).deploy(ethers.getAddress(RELAYER), BASE_USDC);
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("BaseBridgePayout:", addr, "| relayer:", RELAYER, "| usdc:", BASE_USDC);

  const out = path.join(__dirname, "..", "deployments", "base-bridge-payout.json");
  fs.writeFileSync(out, JSON.stringify({ chainId: 8453, relayer: RELAYER, usdc: BASE_USDC, payout: addr, deployedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log("saved", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
