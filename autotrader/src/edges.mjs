// Where the money in the Pons trenches actually goes, measured from the
// recorded tapes in data/:
//   1. the house edge: what the average curve buyer made, by entry age and hold
//   2. the creator's take: creator tax per launch against the cost to launch
//   3. Monte Carlo: random entries through the same book and exits, many
//      seeds, against the strategy, so the strategy has to beat chance
//
//   node src/edges.mjs [--seeds 300]
import { readdirSync, readFileSync } from "node:fs";

import { Account, Engine } from "./engine.mjs";
import { Coin, FEE, sellOut } from "./coin.mjs";
import { CONFIG, entrySignal } from "./strategy.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const SEEDS = Number(arg("seeds", 300));
const dir = new URL("../data/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl") && !f.startsWith("live")).sort();
const tapes = files.map((f) => ({ f, ev: readFileSync(new URL(f, dir), "utf8").trim().split("\n").map(JSON.parse) }));
const pct = (x) => `${(100 * x).toFixed(1)}%`;
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((s, x) => s + x, 0) / Math.max(1, a.length);

// ---------------------------------------------------------------- 1 + 2
console.log("== 1. The house edge: every real curve buy, sold back after H seconds at the curve's price then");
const buckets = [[0, 10], [10, 60], [60, 300], [300, 1800], [1800, 1e9]];
const holds = [30, 300, 1800];
const res = new Map(); // `${bucket}|${hold}` -> returns
const creator = []; // per launch: tax collected (ETH), volume
for (const { ev } of tapes) {
  const coins = new Map();
  const paths = new Map();
  for (const e of ev) {
    if (e.k === "launch") { coins.set(e.token, new Coin(e)); paths.set(e.token, []); continue; }
    const c = coins.get(e.token);
    if (!c || !c.native || c.graduated) continue;
    c.apply(e);
    paths.get(e.token).push({ t: e.t, ...c.reserves(), e });
  }
  for (const [token, path] of paths) {
    const c = coins.get(token);
    if (!c?.native) continue;
    let tax = 0, vol = 0;
    for (let i = 0; i < path.length; i++) {
      const { e } = path[i];
      if (e.k !== "buy" && e.k !== "sell") continue;
      tax += Number(e.tax) / 1e18;
      vol += Number(e.quote) / 1e18;
      if (e.k !== "buy") continue;
      const eth = Number(e.quote) / 1e18, tokens = Number(e.tokens) / 1e18;
      const age = e.t - c.launchT;
      const b = buckets.findIndex(([lo, hi]) => age >= lo && age < hi);
      for (const H of holds) {
        let j = i;
        while (j + 1 < path.length && path[j + 1].t <= e.t + H) j++;
        const { Q, T } = path[j];
        const back = sellOut(Q, T, tokens, c.sellTax);
        const key = `${b}|${H}`;
        if (!res.has(key)) res.set(key, []);
        res.get(key).push(back / eth - 1);
      }
    }
    creator.push({ tax, vol, trades: path.length });
  }
}
console.log("entry age      " + holds.map((h) => `hold ${h}s: mean / median / share up`.padEnd(36)).join(""));
for (let b = 0; b < buckets.length; b++) {
  const label = `${buckets[b][0]}-${buckets[b][1] > 1e8 ? "∞" : buckets[b][1]}s`.padEnd(14);
  console.log(label + holds.map((h) => {
    const r = res.get(`${b}|${h}`) ?? [];
    return `${pct(mean(r)).padStart(7)} / ${pct(q(r, 0.5)).padStart(7)} / ${pct(r.filter((x) => x > 0).length / Math.max(1, r.length)).padStart(6)} (n=${r.length})`.padEnd(36);
  }).join(""));
}
const all = [...res.entries()].filter(([k]) => k.endsWith("|1800")).flatMap(([, v]) => v);
console.log(`all buys, 30-min hold: mean ${pct(mean(all))}, median ${pct(q(all, 0.5))}, top 1% ${pct(q(all, 0.99))}, share that doubled ${pct(all.filter((x) => x >= 1).length / all.length)}`);

console.log("\n== 2. The creator's take (creator tax over the tape, per ETH-paired launch)");
const LAUNCH_COST = 0.0005 + 0.00001; // Pons launch fee + gas
const taxes = creator.map((x) => x.tax);
console.log(`launches ${creator.length}; tax per launch: mean ${mean(taxes).toFixed(5)} ETH, median ${q(taxes, 0.5).toFixed(6)}, p90 ${q(taxes, 0.9).toFixed(4)}, max ${Math.max(...taxes).toFixed(3)}`);
console.log(`launches whose tax covered the ${LAUNCH_COST} ETH launch cost: ${pct(taxes.filter((x) => x >= LAUNCH_COST).length / taxes.length)}; portfolio: ${creator.length} launches cost ${(creator.length * LAUNCH_COST).toFixed(3)} ETH, earned ${taxes.reduce((s, x) => s + x, 0).toFixed(3)} ETH in tax`);
const top = [...taxes].sort((a, b) => b - a);
const top5 = top.slice(0, 5).reduce((s, x) => s + x, 0) / Math.max(1e-18, top.reduce((s, x) => s + x, 0));
console.log(`the top 5 launches took ${pct(top5)} of all creator tax`);

// ---------------------------------------------------------------- 3
console.log(`\n== 3. Monte Carlo: random entries vs the strategy, same book and exits, ${SEEDS} seeds per tape`);
function lcg(seed) { let s = seed >>> 0 || 1; return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32); }
const BAL = 0.1;
function runTape(ev, entry, cfg = CONFIG) {
  const t0 = ev[0].t;
  const eng = new Engine([new Account(0, BAL)], cfg, { entryAfter: t0 + 900, entry });
  for (const e of ev) eng.feed(e);
  eng.finish();
  const a = eng.accounts[0];
  return { ret: a.cash / BAL - 1, trades: a.closed.map((x) => x.ret) };
}
// Pure chance: any ETH-paired curve coin, any moment, a fixed small rate per read.
const pure = (rand, p) => (f) => ({ go: f.age >= 10 && f.progress < 0.95 && rand() < p, score: CONFIG.entryScore + 0.5 });
// Chance among the coins that pass the cheap filters (age, cost, creator bag,
// cohort), with every crowd read switched off: isolates what Hawkes adds.
const loose = { ...CONFIG, minBuys60: 0, minNewBuyers180: 0, minER60: 0, minNBB: -1e9, entryScore: -1e9, maxRunup: 1e9, minOffHigh: 0 };
const gated = (rand, p) => (f, h, social, cfg, c) => {
  const sig = entrySignal(f, h ?? { nBB: 0, alpha: [[0, 0], [0, 0]], lambdaEnd: [1, 0] }, social, loose, c);
  return { go: sig.go && rand() < p, score: CONFIG.entryScore + 0.5 };
};
for (const { f, ev } of tapes) {
  const strat = runTape(ev, entrySignal);
  const n = Math.max(1, strat.trades.length);
  console.log(`${f}: strategy ${pct(strat.ret)} over ${strat.trades.length} trades (mean per trade ${pct(mean(strat.trades))})`);
  for (const [name, mk, p] of [["pure chance", pure, 0.004], ["chance + filters", gated, 0.05]]) {
    const rets = [], per = [], counts = [];
    for (let s = 1; s <= SEEDS; s++) {
      const r = runTape(ev, mk(lcg(s * 7919), p));
      rets.push(r.ret); per.push(...r.trades); counts.push(r.trades.length);
    }
    const beat = rets.filter((x) => x >= strat.ret).length / rets.length;
    console.log(`  ${name.padEnd(17)} account: median ${pct(q(rets, 0.5))}, p5 ${pct(q(rets, 0.05))}, p95 ${pct(q(rets, 0.95))}; per trade mean ${pct(mean(per))}, win ${pct(per.filter((x) => x > 0).length / per.length)}; ~${Math.round(mean(counts))} trades/run; chance >= strategy: ${pct(beat)}`);
  }
}
