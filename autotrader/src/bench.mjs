// Paper benchmark: a hundred accounts, balances log-spaced, one replayed (or
// live) market. Reports what each balance did and how it spread its money.
//
//   node src/bench.mjs data/pons-a-b.jsonl [--accounts 100] [--min 0.005] [--max 20]
//        [--from 0.5 --to 1]   fraction of the file's span in which entries are allowed
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Account, Engine } from "./engine.mjs";
import { CONFIG } from "./strategy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const ETH_USD = Number(process.env.ETH_USD ?? 2533);
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };

export function makeAccounts(n, lo, hi, opts) {
  return Array.from({ length: n }, (_, i) => new Account(i, lo * (hi / lo) ** (n === 1 ? 0 : i / (n - 1)), opts));
}

export function report(eng, label) {
  const rows = eng.accounts.map((a) => {
    const end = a.cash;
    const wins = a.closed.filter((x) => x.out > x.cost).length;
    const dep = a.deployedSamples.length ? a.deployedSamples.reduce((s, x) => s + x, 0) / a.deployedSamples.length : 0;
    const coins = new Set(a.closed.map((x) => x.token)).size;
    return {
      id: a.id, start: a.start, end, pnl: end - a.start, ret: end / a.start - 1, trades: a.closed.length, coins,
      win: a.closed.length ? wins / a.closed.length : 0, deployed: dep, maxDD: a.maxDrawdown, gas: a.gas,
      avgSize: a.closed.length ? a.closed.reduce((s, x) => s + x.cost, 0) / a.closed.length : 0,
      reasons: a.closed.reduce((m, x) => ((m[x.reason] = (m[x.reason] ?? 0) + 1), m), {}),
    };
  });
  const tot = rows.reduce((s, r) => s + r.pnl, 0);
  console.log(`\n== ${label}: ${eng.signals.length} entry signals on ${new Set(eng.signals.map((s) => s.token)).size} coins`);
  console.log("start ETH  ($)       end ETH    return  trades coins  win   avg size  deployed  maxDD");
  for (const r of rows.filter((_, i) => i % Math.max(1, Math.floor(rows.length / 12)) === 0 || i === rows.length - 1)) {
    console.log(
      `${r.start.toFixed(4).padStart(9)} (${("$" + (r.start * ETH_USD).toFixed(0)).padStart(7)})  ${r.end.toFixed(4).padStart(9)}  ${(100 * r.ret).toFixed(1).padStart(6)}%  ${String(r.trades).padStart(6)} ${String(r.coins).padStart(5)}  ${(100 * r.win).toFixed(0).padStart(3)}%  ${r.avgSize.toFixed(4).padStart(8)}  ${(100 * r.deployed).toFixed(1).padStart(6)}%  ${(100 * r.maxDD).toFixed(1).padStart(5)}%`,
    );
  }
  const reasons = {};
  for (const r of rows) for (const [k, v] of Object.entries(r.reasons)) reasons[k] = (reasons[k] ?? 0) + v;
  const pos = rows.filter((r) => r.pnl > 0).length;
  console.log(`accounts up ${pos}/${rows.length}; total P&L ${tot.toFixed(4)} ETH ($${(tot * ETH_USD).toFixed(0)}); exits: ${JSON.stringify(reasons)}`);
  return rows;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const file = process.argv[2];
  const ev = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
  const t0 = ev[0].t, span = ev.at(-1).t - t0;
  const n = Number(arg("accounts", 100)), lo = Number(arg("min", 0.005)), hi = Number(arg("max", 20));
  const windows = arg("from") ? [[Number(arg("from")), Number(arg("to", 1))]] : [[0, 0.5], [0.5, 1]];
  const out = {};
  for (const [a, b] of windows) {
    const eng = new Engine(makeAccounts(n, lo, hi), CONFIG, { entryAfter: t0 + a * span, entryBefore: t0 + b * span });
    const started = Date.now();
    for (const e of ev) {
      if (e.t > t0 + b * span + 1800) break; // let open positions play out 30 min past the window
      eng.feed(e);
    }
    eng.finish();
    const label = `${basename(file)} entries in ${(a * span / 3600).toFixed(1)}–${(b * span / 3600).toFixed(1)} h (${a === 0 ? "calibration" : "untouched"}) [${((Date.now() - started) / 1000).toFixed(1)} s]`;
    out[`${a}-${b}`] = { rows: report(eng, label), signals: eng.signals };
  }
  mkdirSync(join(here, "../runs"), { recursive: true });
  const f = join(here, `../runs/bench-${basename(file, ".jsonl")}-${Date.now()}.json`);
  writeFileSync(f, JSON.stringify(out, null, 1));
  console.log("\nwrote", f);
}
