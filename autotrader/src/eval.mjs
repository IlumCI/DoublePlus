// One strategy, every dataset: the 6 h replay split in two, the recorded live
// hour, and anything else in data/. Prints returns for a spread of balances.
//   node src/eval.mjs [knob=value ...]
import { readdirSync, readFileSync } from "node:fs";

import { Account, Engine } from "./engine.mjs";
import { CONFIG } from "./strategy.mjs";

const cfg = { ...CONFIG };
for (const kv of process.argv.slice(2)) { const [k, v] = kv.split("="); cfg[k] = Number(v); }
const balances = [0.02, 0.1, 0.5, 2, 10];
const dir = new URL("../data/", import.meta.url);
const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
let agg = 0, n = 0;
for (const f of files) {
  const ev = readFileSync(new URL(f, dir), "utf8").trim().split("\n").map(JSON.parse);
  const t0 = ev[0].t, span = ev.at(-1).t - t0;
  // Live tapes start with a 15-min warm-up the live run didn't trade in.
  const windows = f.startsWith("live") ? [[900 / span, 1]] : span > 4 * 3600 ? [[0, 0.5], [0.5, 1]] : [[0, 1]];
  for (const [a, b] of windows) {
    const eng = new Engine(balances.map((x, i) => new Account(i, x)), cfg, { entryAfter: t0 + a * span, entryBefore: t0 + b * span });
    for (const e of ev) { if (e.t > t0 + b * span + 1800) break; eng.feed(e); }
    eng.finish();
    const trades = eng.accounts[1].closed;
    const wins = trades.filter((x) => x.out > x.cost).length;
    const r = eng.accounts.map((x) => x.cash / x.start - 1);
    agg += r[1]; n++;
    console.log(`${f.slice(0, 26).padEnd(26)} ${a.toFixed(2)}-${b.toFixed(2)}  trades ${String(trades.length).padStart(3)}  win ${String(trades.length ? Math.round(100 * wins / trades.length) : 0).padStart(3)}%  ` + r.map((x) => `${(100 * x).toFixed(1).padStart(6)}%`).join(""));
  }
}
console.log(`mean return of the 0.1 ETH account across windows: ${(100 * agg / n).toFixed(1)}%`);
