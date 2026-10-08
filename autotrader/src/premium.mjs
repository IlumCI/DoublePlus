// Stock-token premium recorder. Every minute, for each tokenized stock in
// web/src/venture/stocks.json: its V3 pool price against its Chainlink
// price, appended to data/premium.jsonl with the US market state. Leave it
// running across a weekend; then --summary shows how far pools drift while
// supply is frozen, and how fast the gap closes when the week reopens.
//
//   node src/premium.mjs [--every 60]       record
//   node src/premium.mjs --summary          report what's been recorded
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { ethers } from "ethers";

import { provider } from "./chain.mjs";

const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i > 0 ? process.argv[i + 1] : d; };
const STOCKS = JSON.parse(readFileSync(new URL("../../web/src/venture/stocks.json", import.meta.url), "utf8"));
const DATA = new URL("../data/", import.meta.url);
const FILE = new URL("premium.jsonl", DATA);
const ETH_USD_FEED = "0x78F3556b67E17Df817D51Ef5a990cDaF09E8d3A9";
const USDG_USD_FEED = "0x61B7e5650328764B076A108EFF5fa7282a1B9aD2";

/** Same rules as web/src/venture/stockPremium.ts. */
export function marketState(at) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (parts.weekday === "Sat") return "closed";
  if (parts.weekday === "Sun") return mins >= 20 * 60 ? "extended" : "closed";
  if (parts.weekday === "Fri" && mins >= 20 * 60) return "closed";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  return "extended";
}

function poolPriceUsd(sqrtPriceX96, stockIs0, quoteDecimals, quoteUsd) {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw = s * s * 10 ** (stockIs0 ? 18 - quoteDecimals : quoteDecimals - 18);
  return (stockIs0 ? raw : 1 / raw) * quoteUsd;
}

async function sample(p, token0) {
  const feed = (a) => new ethers.Contract(a, ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)"], p);
  const [eth, usdg] = await Promise.all([feed(ETH_USD_FEED).latestRoundData(), feed(USDG_USD_FEED).latestRoundData()]);
  const quoteUsd = { WETH: Number(eth[1]) / 1e8, USDG: Number(usdg[1]) / 1e8 };
  const now = new Date();
  const state = marketState(now);
  const rows = await Promise.all(STOCKS.map(async (s) => {
    const pool = new ethers.Contract(s.pool, ["function slot0() view returns (uint160,int24,uint16,uint16,uint16,uint8,bool)"], p);
    const [slot0, round] = await Promise.all([pool.slot0(), feed(s.feed).latestRoundData()]);
    const poolUsd = poolPriceUsd(slot0[0], token0.get(s.pool) === s.token.toLowerCase(), s.quote === "USDG" ? 6 : 18, quoteUsd[s.quote]);
    const nav = Number(round[1]) / 1e8;
    return { t: Math.floor(now / 1000), state, sym: s.symbol, pool: +poolUsd.toFixed(4), nav, prem: +(poolUsd / nav - 1).toFixed(5), feedAge: Math.floor(now / 1000) - Number(round[3]) };
  }));
  return rows;
}

function summary() {
  if (!existsSync(FILE)) { console.log("nothing recorded yet"); return; }
  const rows = readFileSync(FILE, "utf8").trim().split("\n").map(JSON.parse);
  const span = (rows.at(-1).t - rows[0].t) / 3600;
  console.log(`${rows.length} samples over ${span.toFixed(1)} h; states: ${[...new Set(rows.map((r) => r.state))].join(", ")}`);
  const by = new Map();
  for (const r of rows) {
    const k = `${r.sym}|${r.state}`;
    if (!by.has(k)) by.set(k, []);
    by.get(k).push(r.prem);
  }
  console.log("stock  state     samples  mean     median   max |prem|  share > 2%");
  const keys = [...by.keys()].sort();
  for (const k of keys) {
    const a = by.get(k), [sym, state] = k.split("|");
    const s = [...a].sort((x, y) => x - y);
    const mean = a.reduce((x, y) => x + y, 0) / a.length;
    const max = Math.max(...a.map(Math.abs));
    const over = a.filter((x) => Math.abs(x) > 0.02).length / a.length;
    console.log(`${sym.padEnd(6)} ${state.padEnd(9)} ${String(a.length).padStart(7)}  ${(100 * mean).toFixed(2).padStart(6)}%  ${(100 * s[s.length >> 1]).toFixed(2).padStart(6)}%  ${(100 * max).toFixed(2).padStart(8)}%  ${(100 * over).toFixed(0).padStart(6)}%`);
  }
  // How fast a weekend gap closed once the week reopened: the first samples
  // after each closed -> extended switch, per stock.
  const reopen = [];
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].state === "extended" && rows[i - 1].state === "closed" && rows[i].sym === rows[i - 1].sym) reopen.push(rows[i]);
  }
  if (reopen.length) console.log(`week reopened ${reopen.length} stock-times; see samples after each for the convergence`);
}

if (process.argv.includes("--summary")) {
  summary();
} else {
  const every = Number(arg("every", 60)) * 1000;
  const p = provider();
  const token0 = new Map();
  for (const s of STOCKS) {
    const pool = new ethers.Contract(s.pool, ["function token0() view returns (address)"], p);
    token0.set(s.pool, (await pool.token0()).toLowerCase());
  }
  if (!existsSync(DATA)) mkdirSync(DATA, { recursive: true });
  console.log(`recording ${STOCKS.length} stocks every ${every / 1000}s to ${FILE.pathname}`);
  for (;;) {
    try {
      const rows = await sample(p, token0);
      appendFileSync(FILE, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
      const widest = rows.reduce((a, b) => (Math.abs(b.prem) > Math.abs(a.prem) ? b : a));
      console.log(`${new Date().toISOString()} ${rows[0].state}: widest ${widest.sym} ${(100 * widest.prem).toFixed(2)}%`);
    } catch (e) {
      console.log("sample failed:", e.shortMessage ?? e.message);
    }
    await new Promise((r) => setTimeout(r, every));
  }
}
