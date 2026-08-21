import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Base mainnet
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
// Aerodrome Slipstream (concentrated-liquidity) SwapRouter — where the Base
// tokenized stocks hold their deep USDC liquidity.
const SLIPSTREAM_ROUTER = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";

/**
 * Deploy StockFlyRouter for the live StockFlyFactoryV2 on Base. One-tap ETH
 * buy/sell: ETH ⇄ WETH ⇄ (Aerodrome Slipstream: WETH/USDC/stock) ⇄ stock ⇄
 * (the coin's own v4 pool) ⇄ coin. The Slipstream path is supplied per trade
 * by the frontend, so the router needs no per-pair config.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  console.log("deployer:", signer.address);

  const depPath = join(__dirname, "..", "deployments", "base-stockfly-v2.json");
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const factory = dep.contracts.factory as string;
  console.log("factory (StockFlyFactoryV2):", factory);

  const router = await (await ethers.getContractFactory("StockFlyRouter")).deploy(
    POOL_MANAGER,
    factory,
    WETH,
    SLIPSTREAM_ROUTER,
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("StockFlyRouter:", routerAddr);

  // Sanity: the router bound the real hook from the factory.
  console.log("  bound hook:", await router.hook());
  console.log("  aeroRouter:", await router.aeroRouter());

  dep.contracts.stockFlyRouter = routerAddr;
  dep.contracts.slipstreamRouter = SLIPSTREAM_ROUTER;
  writeFileSync(depPath, JSON.stringify(dep, null, 2) + "\n");
  console.log("updated", depPath);
  console.log("\nSet VITE_RH_ROUTER =", routerAddr, "in web/.env.base.local");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
