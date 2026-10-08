// Sweep one strategy knob over both halves of a data file, for a few balances.
//   node src/sweep.mjs data/x.jsonl maxImpact 0.03,0.06,0.1,0.2
import { readFileSync } from "node:fs";

import { Account, Engine } from "./engine.mjs";
import { CONFIG } from "./strategy.mjs";

const [file, knob, values] = process.argv.slice(2);
const ev = readFileSync(file, "utf8").trim().split("\n").map(JSON.parse);
const t0 = ev[0].t, span = ev.at(-1).t - t0;
const balances = [0.02, 0.1, 0.5, 2, 10];
console.log(`knob ${knob}; returns for balances ${balances.join(" / ")} ETH`);
for (const v of values.split(",").map(Number)) {
  const cfg = { ...CONFIG, [knob]: v };
  const line = [];
  for (const [a, b] of [[0, 0.5], [0.5, 1]]) {
    const eng = new Engine(balances.map((x, i) => new Account(i, x)), cfg, { entryAfter: t0 + a * span, entryBefore: t0 + b * span });
    for (const e of ev) { if (e.t > t0 + b * span + 1800) break; eng.feed(e); }
    eng.finish();
    line.push(`${a === 0 ? "calib" : "test "} ` + eng.accounts.map((x) => `${(100 * (x.cash / x.start - 1)).toFixed(1).padStart(6)}%`).join(""));
  }
  console.log(`${String(v).padEnd(6)} ${line.join("   |   ")}`);
}
