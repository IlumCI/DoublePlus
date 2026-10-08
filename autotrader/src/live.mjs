// Live paper run: polls Robinhood Chain for new Pons events every second and
// feeds the same engine the replay uses, with a hundred paper accounts.
// Everything it sees is also written to data/live-<start>.jsonl, so the hour
// can be replayed exactly afterwards.
//
//   node src/live.mjs [--minutes 60] [--accounts 100] [--min 0.005] [--max 20]
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { makeAccounts, report } from "./bench.mjs";
import { Engine } from "./engine.mjs";
import { Feed } from "./fetch.mjs";
import { CONFIG } from "./strategy.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const MINUTES = Number(arg("minutes", 60));
const WARMUP_BLOCKS = 9_000; // ~15 min: the oldest coin the strategy would still buy

const feed = new Feed();
const p = feed.p;
const accounts = makeAccounts(Number(arg("accounts", 100)), Number(arg("min", 0.005)), Number(arg("max", 20)));
const started = Date.now();
const tag = new Date(started).toISOString().replace(/[:.]/g, "-");
mkdirSync(join(here, "../data"), { recursive: true });
mkdirSync(join(here, "../runs"), { recursive: true });
const tape = join(here, `../data/live-${tag}.jsonl`);
const snap = join(here, `../runs/live-${tag}.json`);

let head = await p.getBlockNumber();
const warm = await feed.range(head - WARMUP_BLOCKS, head);
const startT = warm.length ? warm[warm.length - 1].t : Date.now() / 1000;
const eng = new Engine(accounts, CONFIG, { entryAfter: startT });
for (const e of warm) eng.feed(e);
appendFileSync(tape, warm.map((e) => JSON.stringify(e)).join("\n") + (warm.length ? "\n" : ""));
console.log(`live from block ${head} (warmed on ${warm.length} events); ${accounts.length} accounts; ${MINUTES} min`);

let seen = warm.length;
let lastLog = 0;
while (Date.now() - started < MINUTES * 60_000) {
  await new Promise((r) => setTimeout(r, 1000));
  let now;
  try {
    now = await p.getBlockNumber();
  } catch { continue; }
  if (now <= head) continue;
  let events;
  try {
    events = await feed.range(head + 1, now);
  } catch (e) {
    console.log("poll failed, retrying:", e.shortMessage ?? e.message);
    continue;
  }
  head = now;
  for (const e of events) eng.feed(e);
  if (events.length) appendFileSync(tape, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  seen += events.length;
  if (Date.now() - lastLog > 60_000) {
    lastLog = Date.now();
    const eq = accounts.reduce((s, a) => s + eng.equity(a), 0);
    const st = accounts.reduce((s, a) => s + a.start, 0);
    const open = accounts.reduce((s, a) => s + a.positions.size, 0);
    const closed = accounts.reduce((s, a) => s + a.closed.length, 0);
    const mins = ((Date.now() - started) / 60_000).toFixed(0);
    console.log(`${mins} min: block ${head}, ${seen} events, ${eng.coins.size} coins, ${eng.signals.length} signals, open ${open}, closed ${closed}, equity ${(100 * (eq / st - 1)).toFixed(2)}%`);
    writeFileSync(snap, JSON.stringify({ head, seen, signals: eng.signals, accounts: accounts.map((a) => ({ id: a.id, start: a.start, cash: a.cash, equity: eng.equity(a), open: [...a.positions.keys()], closed: a.closed })) }));
  }
}
eng.finish();
const rows = report(eng, `live ${MINUTES} min from block ${head}`);
writeFileSync(snap, JSON.stringify({ head, seen, signals: eng.signals, rows }, null, 1));
console.log("tape", tape, "\nsnapshot", snap);
