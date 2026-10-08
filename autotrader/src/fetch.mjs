// Pulls a block range of Pons market data off-chain into a replayable file.
//
//   node src/fetch.mjs --hours 3            (ending at the head)
//   node src/fetch.mjs --from 83200000 --to 83300000
//
// Writes data/pons-<from>-<to>.jsonl: one normalised event per line, sorted by
// (block, logIndex). The node keeps little history state, so everything the
// replay needs comes from logs: curve trades, graduations, and the Uniswap V4
// swaps of graduated Pons pools (whose Swap events carry price and liquidity).
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";

import { iface, PONS, POOL_MANAGER, provider, topic } from "./chain.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const CHUNK = Number(process.env.LOG_CHUNK ?? 5000);

function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : dflt;
}

async function logs(p, filter, from, to) {
  const out = [];
  for (let b = from; b <= to; b += CHUNK) {
    const end = Math.min(to, b + CHUNK - 1);
    for (let attempt = 0; ; attempt++) {
      try {
        out.push(...(await p.getLogs({ ...filter, fromBlock: b, toBlock: end })));
        break;
      } catch (e) {
        if (attempt >= 4) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
      }
    }
  }
  return out;
}

/** Block -> unix seconds (fractional), interpolated between sampled blocks.
 *  Blocks are ~100 ms but their timestamps are whole seconds, so sampling
 *  every SAMPLE blocks and interpolating gives sub-second ordering. */
async function clock(p, from, to) {
  const SAMPLE = 2000;
  const pts = [];
  for (let b = from; b <= to + SAMPLE; b += SAMPLE) {
    const blk = await p.getBlock(Math.min(b, to));
    pts.push([blk.number, blk.timestamp]);
    if (blk.number === to) break;
  }
  return (b) => {
    let i = 1;
    while (i < pts.length - 1 && pts[i][0] < b) i++;
    const [b0, t0] = pts[i - 1], [b1, t1] = pts[i];
    return b1 === b0 ? t0 : t0 + ((b - b0) * (t1 - t0)) / (b1 - b0);
  };
}

/** Keeps the curve -> coin and pool -> coin maps across calls, so a live
 *  poller can ask for one small block range at a time. */
export class Feed {
  constructor(p = provider()) {
    this.p = p;
    this.curveOf = new Map();
    this.poolOf = new Map();
  }

  async range(from, to) {
  const p = this.p;
  const t = await clock(p, from, to);
  const [launches, grads, regs] = await Promise.all([
    logs(p, { address: PONS.factory, topics: [topic("TokenLaunched")] }, from, to),
    logs(p, { address: PONS.factory, topics: [topic("PoolGraduated")] }, from, to),
    logs(p, { address: PONS.hook, topics: [topic("PoolRegistered")] }, from, to),
  ]);
  const curveOf = this.curveOf; // curve -> token
  const events = [];
  for (const l of launches) {
    const e = iface.parseLog(l).args;
    curveOf.set(e.curve.toLowerCase(), e.token.toLowerCase());
    events.push({
      k: "launch", b: l.blockNumber, li: l.index, tx: l.transactionHash,
      token: e.token.toLowerCase(), curve: e.curve.toLowerCase(), deployer: e.deployer.toLowerCase(),
      pair: e.pairToken.toLowerCase(), gradQuote: e.graduationThreshold.toString(),
    });
  }
  // Links and description, set at launch: what a trader saw on the coin page.
  const meta = new ethers.Interface([
    "function socials() view returns (string)",
    "function description() view returns (string)",
  ]);
  const launchEvents = events.filter((e) => e.k === "launch");
  for (let i = 0; i < launchEvents.length; i += 25) {
    await Promise.all(launchEvents.slice(i, i + 25).map(async (e) => {
      for (const fn of ["socials", "description"]) {
        try {
          const r = await p.call({ to: e.token, data: meta.encodeFunctionData(fn) });
          e[fn] = meta.decodeFunctionResult(fn, r)[0].slice(0, 500);
        } catch { e[fn] = ""; }
      }
    }));
  }
  const poolOf = this.poolOf; // poolId -> token
  for (const l of regs) {
    const e = iface.parseLog(l).args;
    poolOf.set(l.topics[1], e.memecoin.toLowerCase());
    events.push({ k: "pool", b: l.blockNumber, li: l.index, tx: l.transactionHash, pool: l.topics[1], token: e.memecoin.toLowerCase(), quote: e.quoteToken.toLowerCase(), creator: e.creator.toLowerCase() });
  }
  for (const l of grads) {
    const e = iface.parseLog(l).args;
    events.push({ k: "grad", b: l.blockNumber, li: l.index, tx: l.transactionHash, token: e.token.toLowerCase(), tokenAmount: e.tokenAmount.toString(), pairAmount: e.pairTokenAmount.toString() });
  }

  // Curve events, chain-wide by topic, kept only for known curves.
  const curveTopics = [topic("CurveBuy"), topic("CurveSell"), topic("SnipeTaxCharged"), topic("CurveCompleted")];
  const curveLogs = await logs(p, { topics: [curveTopics] }, from, to);
  for (const l of curveLogs) {
    const token = curveOf.get(l.address.toLowerCase());
    if (!token) continue;
    const ev = iface.parseLog(l);
    const base = { b: l.blockNumber, li: l.index, tx: l.transactionHash, token };
    const a = ev.args;
    if (ev.name === "CurveBuy") events.push({ ...base, k: "buy", who: a.recipient.toLowerCase(), via: a.buyer.toLowerCase(), quote: a.quoteIn.toString(), tokens: a.tokensOut.toString(), fee: a.fee.toString(), tax: a.tax.toString() });
    else if (ev.name === "CurveSell") events.push({ ...base, k: "sell", who: a.seller.toLowerCase(), quote: a.quoteOut.toString(), tokens: a.tokensIn.toString(), fee: a.fee.toString(), tax: a.tax.toString() });
    else if (ev.name === "SnipeTaxCharged") events.push({ ...base, k: "snipe", who: a.recipient.toLowerCase(), amount: a.amount.toString() });
    else events.push({ ...base, k: "complete" });
  }

  // V4 swaps on graduated Pons pools.
  const ids = [...poolOf.keys()];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    const sw = await logs(p, { address: POOL_MANAGER, topics: [topic("Swap"), batch] }, from, to);
    for (const l of sw) {
      const a = iface.parseLog(l).args;
      events.push({
        k: "swap", b: l.blockNumber, li: l.index, tx: l.transactionHash, token: poolOf.get(l.topics[1]), pool: l.topics[1],
        a0: a.amount0.toString(), a1: a.amount1.toString(), sqrtP: a.sqrtPriceX96.toString(), L: a.liquidity.toString(), tick: Number(a.tick), fee: Number(a.fee),
      });
    }
  }

  // Who signed each V4 swap (the Swap event names the router, not the trader).
  const swapTxs = [...new Set(events.filter((e) => e.k === "swap").map((e) => e.tx))];
  const fromOf = new Map();
  for (let i = 0; i < swapTxs.length; i += 50) {
    const txs = await Promise.all(swapTxs.slice(i, i + 50).map((h) => p.getTransaction(h)));
    for (const tx of txs) if (tx) fromOf.set(tx.hash, tx.from.toLowerCase());
  }
  for (const e of events) {
    if (e.k === "swap") e.who = fromOf.get(e.tx) ?? null;
    e.t = Math.round(t(e.b) * 1000) / 1000;
  }
  events.sort((x, y) => x.b - y.b || x.li - y.li);
  return events;
  }
}

export async function fetchRange(from, to) {
  return new Feed().range(from, to);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const p = provider();
  const head = await p.getBlockNumber();
  const hours = Number(arg("hours", 0));
  const to = Number(arg("to", head));
  const from = Number(arg("from", hours ? to - Math.round(hours * 36_000) : to - 6_000));
  console.log(`fetching ${from}..${to} (${((to - from) / 36_000).toFixed(2)} h)`);
  const t0 = Date.now();
  const events = await fetchRange(from, to);
  const dir = join(here, "../data");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `pons-${from}-${to}.jsonl`);
  writeFileSync(file, events.map((e) => JSON.stringify(e)).join("\n") + "\n");
  const count = {};
  for (const e of events) count[e.k] = (count[e.k] ?? 0) + 1;
  console.log(file, count, `${((Date.now() - t0) / 1000).toFixed(0)} s`);
}
