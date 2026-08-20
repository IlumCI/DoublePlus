import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

/// One real buy + sell + harvest on the freshly launched CHECK token, proving
/// the 80/20 native-USDC push end to end on Arc mainnet.
async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/arc-v4-launchpad.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const token = "0x13c8EAEa033391F1e824A8550772c85054014663";
  const router = await ethers.getContractAt("QuiverRouter", dep.contracts.router);
  const hook = await ethers.getContractAt("QuiverHook", dep.contracts.hook);
  const erc20 = await ethers.getContractAt("QuiverToken", token);

  console.log("buying 0.2 USDC of CHECK…");
  await (await router.buy(token, 0, { value: ethers.parseEther("0.2") })).wait();
  const held = await erc20.balanceOf(signer.address);
  console.log("held:", ethers.formatEther(held), "CHECK");

  console.log("selling a quarter back…");
  await (await erc20.approve(await router.getAddress(), held)).wait();
  await (await router.sell(token, held / 4n, 0)).wait();

  const pendingW = await hook.wethFees(token);
  const pendingT = await hook.tokenFees(token);
  console.log("accrued fees — quote:", ethers.formatEther(pendingW), "token:", ethers.formatEther(pendingT));

  const creator = signer.address; // deployer launched CHECK
  const treasury = await hook.protocolTreasury();
  const cb = await ethers.provider.getBalance(creator);
  const tb = await ethers.provider.getBalance(treasury);

  console.log("harvesting…");
  const rc = await (await hook.harvest(token)).wait();
  const gas = rc!.gasUsed * rc!.gasPrice;

  const cg = (await ethers.provider.getBalance(creator)) - cb + gas; // creator paid harvest gas
  const tg = (await ethers.provider.getBalance(treasury)) - tb;
  console.log("creator gain (net of gas):", ethers.formatEther(cg), "USDC");
  console.log("treasury gain:", ethers.formatEther(tg), "USDC");
}
main().catch((e) => { console.error(e); process.exit(1); });
