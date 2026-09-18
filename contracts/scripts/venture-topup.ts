import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Closes the last wei of a raise and graduates it. The curve rounds each
// buy's cost UP, so a single grossed-up buy lands a few wei short of target;
// this walks the remainder down and then finalizes.
const eth = (v: bigint) => ethers.formatEther(v);

async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments", process.env.DEPLOYMENTS ?? "venture-testnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("VentureFactory", dep.contracts.factory);
  const coin = process.env.TOKEN!;
  const buyBps = BigInt(await factory.curveBuyFeeBps());

  for (let i = 0; i < 6; i++) {
    const s = await factory.curveState(coin);
    const gap = s.targetRaiseWei - s.raisedWei;
    console.log(`raised ${eth(s.raisedWei)} / ${eth(s.targetRaiseWei)}  gap ${gap} wei`);
    if (gap <= 0n) break;
    // Gross up so the entry fee still leaves `gap` reaching escrow.
    const value = (gap * 10_000n) / (10_000n - buyBps) + 2n;
    try {
      await (await factory.buy(coin, { value })).wait();
    } catch (e: any) {
      console.log("  top-up buy rejected:", e.shortMessage ?? e.message);
      break;
    }
  }

  const s = await factory.curveState(coin);
  if (s.raisedWei < s.targetRaiseWei) throw new Error(`still under target by ${s.targetRaiseWei - s.raisedWei} wei`);

  const rec = await (await factory.finalize(coin)).wait();
  const l = await factory.listings(coin);
  console.log("GRADUATED. poolId:", l.poolId, `(gas ${rec!.gasUsed})`);
  const tp = await factory.tokenPositions(coin);
  const pp = await factory.pairPositions(coin);
  console.log("locked token position:", tp.liquidity.toString(), `ticks [${tp.tickLower}, ${tp.tickUpper}]`);
  console.log("locked pair position: ", pp.liquidity.toString(), `ticks [${pp.tickLower}, ${pp.tickUpper}]`);
  console.log("balance left:", eth(await ethers.provider.getBalance(signer.address)), "ETH");
}
main().catch((e) => { console.error(e); process.exit(1); });
