/**
 * Deploy the ArcBridgePayout receipt contract for the instant bridge.
 * Run when the Arc RPC is reachable:
 *   set -a && source .env.deployer && set +a
 *   ROBINHOOD_RPC_URL=<arc rpc> ROBINHOOD_CHAIN_ID=5042 \
 *   npx hardhat run scripts/deploy-bridge-payout.ts --network robinhood
 */
import fs from "node:fs";
import path from "node:path";
import { ethers } from "hardhat";

const RELAYER = process.env.RELAYER_ADDRESS ?? "0xe5b498a00596ab2fa0e8a86cdde15502b2552208";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "USDC");
  const c = await (await ethers.getContractFactory("ArcBridgePayout")).deploy(ethers.getAddress(RELAYER));
  await c.waitForDeployment();
  const addr = await c.getAddress();
  console.log("ArcBridgePayout:", addr, "| relayer:", RELAYER);
  const out = path.join(__dirname, "..", "deployments", "arc-bridge-payout.json");
  fs.writeFileSync(out, JSON.stringify({ chainId: 5042, relayer: RELAYER, payout: addr, deployedAt: new Date().toISOString() }, null, 2) + "\n");
  console.log("saved", out);
}

main().catch((e) => { console.error(e); process.exit(1); });
