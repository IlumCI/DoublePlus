import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

/**
 * Proves the fee path end to end on the live chain: buys a small amount of
 * TOKEN through the Launchpad, then shows the FeeAccrued event and the
 * FeeDistributor accounting for the token's creator.
 */
async function main() {
  const [signer] = await ethers.getSigners();
  const d = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "deployments", `${network.name}.json`), "utf8")
  );
  const launchpad = await ethers.getContractAt("Launchpad", d.contracts.launchpad);
  const feeDistributor = await ethers.getContractAt("FeeDistributor", d.contracts.feeDistributor);

  const token = process.env.TOKEN!;
  const buyEth = process.env.BUY_ETH ?? "0.0005";
  const info = await launchpad.tokenInfo(token);
  const creator = info.creator;

  const before = await ethers.provider.getBalance(creator);
  const lifetimeBefore = await feeDistributor.creatorLifetimeEarned(creator);
  console.log(`Creator:          ${creator}`);
  console.log(`Balance before:   ${ethers.formatEther(before)} ETH`);
  console.log(`Lifetime before:  ${ethers.formatEther(lifetimeBefore)} ETH`);

  const deadline = Math.floor(Date.now() / 1000) + 600;
  const tx = await launchpad.buy(token, 0, deadline, { value: ethers.parseEther(buyEth) });
  console.log(`\nBuy ${buyEth} ETH submitted: ${tx.hash}`);
  const receipt = await tx.wait();

  for (const log of receipt!.logs) {
    try {
      const parsed = feeDistributor.interface.parseLog(log);
      if (parsed?.name === "FeeAccrued") {
        console.log(
          `FeeAccrued: token=${parsed.args.token} creator=${parsed.args.creator} ` +
            `amount=${ethers.formatEther(parsed.args.amount)} ETH pushed=${parsed.args.pushed}`
        );
      }
    } catch {}
  }

  const after = await ethers.provider.getBalance(creator);
  const lifetimeAfter = await feeDistributor.creatorLifetimeEarned(creator);
  const pending = await feeDistributor.creatorPending(creator);
  console.log(`\nBalance after:    ${ethers.formatEther(after)} ETH`);
  console.log(`Lifetime after:   ${ethers.formatEther(lifetimeAfter)} ETH`);
  console.log(`Pending (pull):   ${ethers.formatEther(pending)} ETH`);
  console.log(`Fee earned now:   ${ethers.formatEther(lifetimeAfter - lifetimeBefore)} ETH`);
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
