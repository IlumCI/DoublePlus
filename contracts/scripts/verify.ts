import { network, run } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Verifies the deployed contracts on the chain's Blockscout explorer using
 * the deployment file written by deploy.ts. Requires BLOCKSCOUT_URL and
 * ROBINHOOD_CHAIN_ID in the environment (see hardhat.config.ts).
 */
async function main() {
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  if (!fs.existsSync(file)) {
    throw new Error(`No deployment file for network '${network.name}'. Run deploy first.`);
  }
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const c = d.contracts;

  const graduationCap = process.env.GRADUATION_CAP_USD_8 ?? String(40_000n * 10n ** 8n);
  const ethUsd = process.env.ETH_USD_PRICE_8;
  if (!ethUsd) throw new Error("ETH_USD_PRICE_8 must match the value used at deploy time");

  const targets: Array<{ name: string; address: string; args: unknown[] }> = [
    { name: "TokenFactory", address: c.tokenFactory, args: [] },
    { name: "Treasury", address: c.treasury, args: [d.deployer] },
    { name: "FeeDistributor", address: c.feeDistributor, args: [d.deployer] },
    {
      name: "Launchpad",
      address: c.launchpad,
      args: [
        d.deployer,
        c.tokenFactory,
        d.uniswap.factory,
        d.uniswap.positionManager,
        d.uniswap.swapRouter,
        d.uniswap.weth,
        c.feeDistributor,
        c.treasury,
        graduationCap,
        ethUsd,
      ],
    },
  ];

  for (const t of targets) {
    console.log(`Verifying ${t.name} at ${t.address} ...`);
    try {
      await run("verify:verify", { address: t.address, constructorArguments: t.args });
      console.log(`${t.name} verified.`);
    } catch (err: any) {
      if (String(err.message).toLowerCase().includes("already verified")) {
        console.log(`${t.name} already verified.`);
      } else {
        throw err;
      }
    }
  }

  console.log(
    "Note: LaunchToken instances are verified once per chain automatically by " +
      "Blockscout bytecode matching. To verify the first instance, run:\n" +
      "  npx hardhat verify --network robinhood <tokenAddress> <constructorArgs...>"
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
