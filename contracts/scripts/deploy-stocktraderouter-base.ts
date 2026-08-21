import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";

/** Deploy StockTradeRouter for the live StockFlyFactoryV2 on Base. Coins trade
 *  directly against their pair token (USDC or a tokenized stock) in their own
 *  v4 pool — no external DEX, so trading never breaks on third-party liquidity. */
async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const depPath = join(__dirname, "..", "deployments", "base-stockfly-v2.json");
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const factory = dep.contracts.factory as string;

  const router = await (await ethers.getContractFactory("StockTradeRouter")).deploy(POOL_MANAGER, factory, WETH);
  await router.waitForDeployment();
  const addr = await router.getAddress();
  console.log("StockTradeRouter:", addr);

  dep.contracts.stockTradeRouter = addr;
  writeFileSync(depPath, JSON.stringify(dep, null, 2) + "\n");
  console.log("updated", depPath);
  console.log("\nSet VITE_RH_ROUTER =", addr, "in web/.env.base.local");
}

main().catch((e) => { console.error(e); process.exit(1); });
