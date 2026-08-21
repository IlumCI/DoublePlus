import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const VIRTUAL = "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31";

const RDOGE = "0x6B4b48D8860Be48aAdd37Ad3f2BA4523989a4663"; // NVDA-paired
const MPRINT = "0x68017e32f26956C875dD7F9F277a468598C04663"; // VIRTUAL-paired

const pack = (types: string[], vals: any[]) => ethers.solidityPacked(types, vals);
const buyPathNvda = pack(["address", "uint24", "address", "uint24", "address"], [WETH, 100, USDG, 3000, NVDA]);
const buyPathVirtual = pack(["address", "uint24", "address"], [WETH, 3000, VIRTUAL]);

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-fork.json"), "utf8"));
  const router = await ethers.getContractAt("RhRouter", dep.contracts.router as string);
  const hook = await ethers.getContractAt("RhHook", dep.contracts.hook as string);

  const buyAmt = ethers.parseEther("0.0002");

  for (const [label, coin, path, pair] of [
    ["stock/NVDA", RDOGE, buyPathNvda, NVDA],
    ["meme/VIRTUAL", MPRINT, buyPathVirtual, VIRTUAL],
  ] as const) {
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const before = await erc.balanceOf(signer.address);
    await (await router.buy(coin, path, 0, { value: buyAmt })).wait();
    const got = (await erc.balanceOf(signer.address)) - before;
    console.log(`${label}: bought ${ethers.formatEther(got)} ${await erc.symbol()}  (tokenFees=${await hook.tokenFees(coin)})`);
  }

  // Prove the reward path on the stock-paired coin: harvest, then claim NVDA.
  console.log("\n-- harvest + claim (NVDA reward) --");
  const rdoge = await ethers.getContractAt("QuiverToken", RDOGE);
  const nvda = await ethers.getContractAt("QuiverToken", NVDA); // ERC20 subset
  await (await hook.harvest(RDOGE)).wait();
  const distributed = await rdoge.totalRewardsDistributed();
  const pending = await rdoge.pendingRewards(signer.address);
  console.log("NVDA distributed to holders:", ethers.formatEther(distributed));
  console.log("holder pending NVDA:", ethers.formatEther(pending));
  if (pending > 0n) {
    const before = await nvda.balanceOf(signer.address);
    await (await rdoge.claim()).wait();
    const claimed = (await nvda.balanceOf(signer.address)) - before;
    console.log("claimed NVDA to wallet:", ethers.formatEther(claimed));
  }
  console.log("\nbalance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
