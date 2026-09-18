import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// The last wei of a raise cannot always be closed by the buyer who filled it:
// once the remaining gap is smaller than the price of one whole token, and
// that buyer's per-wallet cap is spent, their buy mints nothing and reverts.
// A second buyer has a fresh cap, which is the normal case on a real raise.
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments", process.env.DEPLOYMENTS ?? "venture-testnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("VentureFactory", dep.contracts.factory);
  const coin = process.env.TOKEN!;

  // Deterministic second buyer so reruns reuse the same funded account.
  const second = new ethers.Wallet(ethers.id("doubleplus-second-buyer-1"), ethers.provider);
  console.log("second buyer:", second.address);
  const bal = await ethers.provider.getBalance(second.address);
  const need = ethers.parseEther("0.0008");
  if (bal < need) {
    await (await signer.sendTransaction({ to: second.address, value: need - bal })).wait();
    console.log("funded to", eth(await ethers.provider.getBalance(second.address)), "ETH");
  }

  const before = await factory.curveState(coin);
  console.log(`raised ${eth(before.raisedWei)} / ${eth(before.targetRaiseWei)}  gap ${before.targetRaiseWei - before.raisedWei} wei`);

  // One whole token costs more than the gap, so overshoot: the curve caps the
  // spend at what it needs and the buyer keeps the rest as tokens.
  await (await factory.connect(second).buy(coin, { value: ethers.parseEther("0.0002") })).wait();
  const after = await factory.curveState(coin);
  console.log(`raised ${eth(after.raisedWei)} / ${eth(after.targetRaiseWei)}  (target met: ${after.raisedWei >= after.targetRaiseWei})`);

  if (after.raisedWei < after.targetRaiseWei) throw new Error("still under target");

  const rec = await (await factory.finalize(coin)).wait();
  const l = await factory.listings(coin);
  console.log("GRADUATED. poolId:", l.poolId, `(gas ${rec!.gasUsed})`);
  const tp = await factory.tokenPositions(coin);
  const pp = await factory.pairPositions(coin);
  console.log("locked token position:", tp.liquidity.toString(), `ticks [${tp.tickLower}, ${tp.tickUpper}]`);
  console.log("locked pair position: ", pp.liquidity.toString(), `ticks [${pp.tickLower}, ${pp.tickUpper}]`);
  console.log("deployer balance:", eth(await ethers.provider.getBalance(signer.address)), "ETH");
}
main().catch((e) => { console.error(e); process.exit(1); });
