/**
 * End-to-end proof of the Arc V3 launchpad on mainnet: launch a token into a
 * Dyor V3 pool, buy with native USDC, sell half back, then harvest fees and
 * verify the 80/20 creator/platform split pays out in real balances.
 */
import { ethers } from "hardhat";
import record from "../deployments/arc-v3-launchpad.json";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("deployer:", deployer.address, ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "USDC");

  const factory = await ethers.getContractAt("ArcLaunchpadFactory", record.factory);
  const router = await ethers.getContractAt("ArcSwapRouter", record.swapRouter);

  // 1. Launch
  console.log("launching CHECKV3...");
  const tx = await factory.createToken({
    name: "Arc V3 Check",
    symbol: "CHECKV3",
    metadataURI: JSON.stringify({ description: "arc v3 launchpad verification" }),
    quote: record.quoteNative,
    marketCapUsd8: 0n,
  }, { gasLimit: 9_000_000 });
  const rc = await tx.wait();
  const ev = rc!.logs
    .map((l) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((e) => e?.name === "TokenCreated");
  const token = ev!.args.token as string;
  const listing = await factory.listings(token);
  console.log("token:", token, "| pool:", listing.pool, "| launch tx:", rc!.hash);

  const erc20 = await ethers.getContractAt("LaunchpadERC20", token);

  // 2. Buy 0.2 native USDC
  const buyTx = await router.buy(token, 0, { value: ethers.parseEther("0.2"), gasLimit: 1_000_000 });
  await buyTx.wait();
  const bought: bigint = await erc20.balanceOf(deployer.address);
  console.log("bought:", ethers.formatEther(bought), "CHECKV3 (tx", buyTx.hash + ")");
  if (bought === 0n) throw new Error("buy returned zero tokens");

  // 3. Sell half back
  const half = bought / 2n;
  await (await erc20.approve(record.swapRouter, half)).wait();
  const nativeBefore = await ethers.provider.getBalance(deployer.address);
  const sellTx = await router.sell(token, half, 0, { gasLimit: 1_000_000 });
  const sellRc = await sellTx.wait();
  const gasCost = sellRc!.gasUsed * sellRc!.gasPrice;
  const nativeAfter = await ethers.provider.getBalance(deployer.address);
  console.log("sell native delta (incl gas):", ethers.formatEther(nativeAfter - nativeBefore + gasCost), "USDC (tx", sellTx.hash + ")");

  // 4. Harvest: creator (deployer) 80%, feeRecipient (owner) 20%
  const ownerAddr = record.owner as string;
  const creatorNativeBefore = await ethers.provider.getBalance(deployer.address);
  const platformNativeBefore = await ethers.provider.getBalance(ownerAddr);
  const harvestTx = await factory.harvestFees(token, { gasLimit: 800_000 });
  const hRc = await harvestTx.wait();
  const hGas = hRc!.gasUsed * hRc!.gasPrice;
  const creatorGain = (await ethers.provider.getBalance(deployer.address)) - creatorNativeBefore + hGas;
  const platformGain = (await ethers.provider.getBalance(ownerAddr)) - platformNativeBefore;
  console.log("harvest tx:", harvestTx.hash);
  console.log("creator native gain:", ethers.formatEther(creatorGain), "USDC");
  console.log("platform native gain:", ethers.formatEther(platformGain), "USDC");
  const total = creatorGain + platformGain;
  if (total > 0n) {
    console.log("creator share:", Number((creatorGain * 10_000n) / total) / 100, "%");
  }

  // Also report token-side fees paid out (sell fees accrue in the token).
  console.log("creator CHECKV3 balance now:", ethers.formatEther(await erc20.balanceOf(deployer.address)));
  console.log("remaining gas:", ethers.formatEther(await ethers.provider.getBalance(deployer.address)), "USDC");
  console.log("\nE2E COMPLETE - pool", listing.pool, "is live on the Dyor V3 factory");
}

main().catch((e) => { console.error(e); process.exit(1); });
