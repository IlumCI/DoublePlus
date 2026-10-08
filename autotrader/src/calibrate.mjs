// What separates the coins that ran from the ones that didn't, at the moment
// a trader could have bought? Replays a data file, reads every native coin's
// features at each buy (2 s apart at most), and labels each read by what the
// price did next: "ran" if it hit +50% before -25% within 15 minutes.
//
//   node src/calibrate.mjs data/pons-a-b.jsonl [--split 0.5]
// Only the first `split` of the file's time span is read, so the rest stays
// untouched for testing.
import { readFileSync } from "node:fs";

import { Coin } from "./coin.mjs";

const file = process.argv[2];
const split = Number(process.argv[process.argv.indexOf("--split") + 1] || 0.5);
const ev = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const tEnd = ev[0].t + (ev.at(-1).t - ev[0].t) * split;

const coins = new Map();
const reads = [];
const last = new Map();
for (const e of ev) {
  if (e.t > tEnd) break;
  if (e.k === "launch") { coins.set(e.token, new Coin(e)); continue; }
  const c = coins.get(e.token);
  if (!c) continue;
  c.apply(e);
  if (e.k !== "buy" || !c.native || c.graduated) continue;
  if (e.t - (last.get(c.token) ?? -1e9) < 2) continue;
  last.set(c.token, e.t);
  const f = c.features(e.t);
  if (f.age < 10 || f.buys60 < 2) continue;
  const h = c.hawkes(e.t);
  reads.push({ token: c.token, t: e.t, f, h: h && { nBB: h.nBB, n: h.n, aSB: h.alpha[1][0], lb: h.lambdaEnd[0], ls: h.lambdaEnd[1], eb: h.lambdaEnd[0] > 0 ? 1 - h.mu[0] / h.lambdaEnd[0] : 0 } });
}

// Forward outcome from each coin's own later price path.
const path = new Map();
{
  const cs = new Map();
  for (const e of ev) {
    if (e.k === "launch") { cs.set(e.token, new Coin(e)); continue; }
    const c = cs.get(e.token);
    if (!c) continue;
    c.apply(e);
    if (!path.has(c.token)) path.set(c.token, []);
    path.get(c.token).push([e.t, c.price()]);
  }
}
for (const r of reads) {
  const p0 = r.f.price;
  let label = "flat";
  let best = 1;
  for (const [t, p] of path.get(r.token)) {
    if (t <= r.t + 1) continue;
    if (t > r.t + 900) break;
    best = Math.max(best, p / p0);
    if (p / p0 <= 0.75) { label = "dumped"; break; }
    if (p / p0 >= 1.5) { label = "ran"; break; }
  }
  r.label = label;
  r.best = best;
  // Exit view: does a dump wave (-20%) land within the next 2 minutes?
  let wave = false;
  for (const [t, p] of path.get(r.token)) {
    if (t <= r.t + 0.5) continue;
    if (t > r.t + 120) break;
    if (p / p0 <= 0.8) { wave = true; break; }
  }
  r.wave = wave;
}
if (process.argv.includes("--exit")) {
  const base = reads.filter((r) => r.wave).length / reads.length;
  console.log(`exit view: ${reads.length} reads, ${(100 * base).toFixed(0)}% see a -20% wave within 2 min`);
  const xf = {
    earlySold60: (r) => r.f.earlySold60, earlyShare: (r) => r.f.earlyShare, sellPress60: (r) => r.f.sellPress60,
    largestSell60: (r) => r.f.largestSell60, er60: (r) => r.f.er60, sizeTrend: (r) => r.f.sizeNow / Math.max(r.f.sizePrev, 1e-9),
    buyTrend: (r) => (r.f.buys60 + 1) / (r.f.buysPrev60 + 1), progress: (r) => r.f.progress, offHigh: (r) => r.f.offHigh,
    runup: (r) => r.f.runup, nBB: (r) => r.h?.nBB ?? -1, nSS: (r) => r.h?.n ?? -1, aSB: (r) => r.h?.aSB ?? -1,
    lsOverLb: (r) => (r.h ? r.h.ls / Math.max(r.h.lb, 1e-9) : -1), age: (r) => r.f.age, idle: (r) => r.f.idle,
  };
  for (const [name, fn] of Object.entries(xf)) {
    const sorted = [...reads].sort((a, b) => fn(a) - fn(b));
    const parts = [];
    for (let i = 0; i < 5; i++) {
      const sl = sorted.slice(Math.floor((i * reads.length) / 5), Math.floor(((i + 1) * reads.length) / 5));
      if (!sl.length) continue;
      parts.push(`[${fmt(fn(sl[0]))}..${fmt(fn(sl[sl.length - 1]))}] wave ${((100 * sl.filter((r) => r.wave).length) / sl.length).toFixed(0)}%`);
    }
    console.log(name.padEnd(13), parts.join("  "));
  }
  process.exit(0);
}

const total = reads.length;
const count = (rs, l) => rs.filter((r) => r.label === l).length;
console.log(`reads ${total} on ${new Set(reads.map((r) => r.token)).size} coins: ran ${count(reads, "ran")} dumped ${count(reads, "dumped")} flat ${count(reads, "flat")}`);

// For each feature, the run rate by quintile: which way does it point?
const feats = {
  age: (r) => r.f.age, progress: (r) => r.f.progress, buys60: (r) => r.f.buys60, er60: (r) => r.f.er60,
  newBuyers180: (r) => r.f.newBuyers180, accel: (r) => (r.f.newBuyers180 + 1) / (r.f.newBuyersPrev180 + 1),
  runup: (r) => r.f.runup, top10: (r) => r.f.top10, earlyShare: (r) => r.f.earlyShare, earlyLeft: (r) => r.f.earlyLeft,
  sizeNow: (r) => r.f.sizeNow, sellPress60: (r) => r.f.sellPress60, offHigh: (r) => r.f.offHigh, mcapEth: (r) => r.f.mcapEth,
  nBB: (r) => r.h?.nBB ?? -1, n: (r) => r.h?.n ?? -1, aSB: (r) => r.h?.aSB ?? -1, eb: (r) => r.h?.eb ?? -1,
  lbOverLs: (r) => (r.h ? r.h.lb / Math.max(r.h.ls, 1e-9) : -1),
};
for (const [name, fn] of Object.entries(feats)) {
  const sorted = [...reads].sort((a, b) => fn(a) - fn(b));
  const q = 5;
  const parts = [];
  for (let i = 0; i < q; i++) {
    const s = sorted.slice(Math.floor((i * total) / q), Math.floor(((i + 1) * total) / q));
    if (!s.length) continue;
    const lo = fn(s[0]), hi = fn(s[s.length - 1]);
    parts.push(`[${fmt(lo)}..${fmt(hi)}] ran ${((100 * count(s, "ran")) / s.length).toFixed(0)}% dump ${((100 * count(s, "dumped")) / s.length).toFixed(0)}%`);
  }
  console.log(name.padEnd(13), parts.join("  "));
}
function fmt(x) {
  return Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 1 ? x.toFixed(2) : x.toFixed(3);
}
