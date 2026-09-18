import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Trades a graduated pool through the VentureRouter so the token page has a
// real chart, stat strip, buy/sell strength bar and trade tape to render.
const eth = (v: bigint) => ethers.formatEther(v);
const nap = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments", process.env.DEPLOYMENTS ?? "venture-testnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const router = await ethers.getContractAt("VentureRouter", dep.contracts.router);
  const coin = process.env.TOKEN!;
  const token = await ethers.getContractAt("QuiverToken", coin);
  const second = new ethers.Wallet(ethers.id("doubleplus-second-buyer-1"), ethers.provider);

  // A mixed tape: alternating sizes and both directions, from two wallets, so
  // the 5m/1h/4h/24h deltas and the buy/sell pressure bar have real inputs.
  const plan: [string, "buy" | "sell", string][] = JSON.parse(process.env.PLAN ?? `[
    ["A", "buy",  "0.00030"],
    ["B", "buy",  "0.00018"],
    ["A", "sell", "35"],
    ["A", "buy",  "0.00022"],
    ["B", "buy",  "0.00012"],
    ["A", "sell", "20"],
    ["A", "buy",  "0.00015"]
  ]`);
  // Spacing matters for the chart: trades packed into one minute are one
  // candle at every interval, correctly, and prove nothing about bucketing.
  const gapMs = Number(process.env.GAP_MS ?? 2500);

  for (const [who, side, amt] of plan) {
    const w = who === "A" ? signer : second;
    try {
      if (side === "buy") {
        const r = await (await router.connect(w).buy(coin, "0x", 0, { value: ethers.parseEther(amt) })).wait();
        console.log(`  ${who} buy  ${amt} ETH   gas ${r!.gasUsed}`);
      } else {
        const bal = await token.balanceOf(w.address);
        const pctAmt = (bal * BigInt(amt)) / 100n;
        if (pctAmt === 0n) { console.log(`  ${who} sell skipped (no balance)`); continue; }
        await (await token.connect(w).approve(dep.contracts.router, pctAmt)).wait();
        const r = await (await router.connect(w).sell(coin, pctAmt, "0x", 0)).wait();
        console.log(`  ${who} sell ${amt}% of balance   gas ${r!.gasUsed}`);
      }
    } catch (e: any) {
      console.log(`  ${who} ${side} ${amt} failed:`, (e.shortMessage ?? e.message).slice(0, 120));
    }
    await nap(gapMs); // spread across blocks so the candles are not one bar
  }

  console.log("\ndeployer balance:", eth(await ethers.provider.getBalance(signer.address)), "ETH");
  console.log("second balance:  ", eth(await ethers.provider.getBalance(second.address)), "ETH");
}
main().catch((e) => { console.error(e); process.exit(1); });
