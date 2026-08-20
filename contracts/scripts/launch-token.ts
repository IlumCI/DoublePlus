import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Launches a token through the live Launchpad. Signed by whatever key is
 * configured for the network (the platform deployer by default; launching
 * needs no roles, anyone can launch).
 *
 * Usage:
 *   TOKEN_NAME="My Token" TOKEN_SYMBOL=MTK LIQUIDITY_ETH=0.05 \
 *   TOKEN_DESCRIPTION="..." TOKEN_LOGO= TOKEN_WEBSITE= TOKEN_TWITTER= TOKEN_TELEGRAM= \
 *     npx hardhat run scripts/launch-token.ts --network robinhood
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8")
  );
  const launchpad = await ethers.getContractAt("Launchpad", d.contracts.launchpad);

  const name = process.env.TOKEN_NAME;
  const symbol = process.env.TOKEN_SYMBOL;
  if (!name || !symbol) {
    throw new Error("Set TOKEN_NAME and TOKEN_SYMBOL");
  }
  // Launching is free: pools are seeded single-sided with the full supply.
  // FIRST_BUY_ETH optionally executes a first buy in the same transaction.
  const value = ethers.parseEther(process.env.FIRST_BUY_ETH ?? "0");

  const balance = await ethers.provider.getBalance(signer.address);
  console.log(`Signer ${signer.address} balance ${ethers.formatEther(balance)} ETH`);
  console.log(`Launching "${name}" (${symbol}) with first buy ${ethers.formatEther(value)} ETH`);
  if (balance <= value) throw new Error("Signer balance cannot cover the first buy plus gas");

  const metadataURI = JSON.stringify({
    description: process.env.TOKEN_DESCRIPTION ?? "",
    logo: process.env.TOKEN_LOGO ?? "",
    website: process.env.TOKEN_WEBSITE ?? "",
    twitter: process.env.TOKEN_TWITTER ?? "",
    telegram: process.env.TOKEN_TELEGRAM ?? "",
    links: [],
  });

  const tx = await launchpad.createToken({ name, symbol, metadataURI }, { value });
  console.log(`Submitted: ${tx.hash}`);
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l) => {
      try {
        return launchpad.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.name === "TokenLaunched");

  console.log(`Token:  ${log!.args.token}`);
  console.log(`Pool:   ${log!.args.pool}`);
  console.log(`LP NFT: ${log!.args.positionTokenId}`);
  console.log(`Trade it at /token/${String(log!.args.token).toLowerCase()}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
