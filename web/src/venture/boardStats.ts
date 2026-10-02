import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";

import { boughtEvent, VENTURE, venturePc } from "./client";
import { computeStats, type CurveStats, type LaunchLog, type TradeLog } from "./curveStats";

export type { CurveStats } from "./curveStats";

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, uint256 targetRaiseWei, uint64 deadline, address vesting)",
);
const soldEvent = parseAbiItem(
  "event CurveSell(address indexed token, address indexed seller, uint256 ethOut, uint256 tokensIn, uint128 priceWei, uint256 feeWei)",
);

// Polls the factory's curve events and keeps computeStats' output fresh.
const POLL_MS = 30_000;
let launches: LaunchLog[] = [];
let buys: TradeLog[] = [];
let sells: TradeLog[] = [];
let secsPerBlock = 0.25;
let lastBlock = 0n;
let stats = new Map<string, CurveStats>();
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

async function refresh() {
  const head = await venturePc.getBlockNumber();
  if (lastBlock === 0n) {
    const back = head > 20_000n ? head - 20_000n : 0n;
    const [a, b] = await Promise.all([venturePc.getBlock({ blockNumber: head }), venturePc.getBlock({ blockNumber: back })]);
    if (head > back) secsPerBlock = Math.max(0.05, (Number(a.timestamp) - Number(b.timestamp)) / Number(head - back));
  }
  const from = lastBlock === 0n ? VENTURE.startBlock : lastBlock + 1n;
  if (from > head) return;
  const f = VENTURE.factory;
  const [l, bo, so] = await Promise.all([
    venturePc.getLogs({ address: f, event: launchedEvent, fromBlock: from, toBlock: head }),
    venturePc.getLogs({ address: f, event: boughtEvent, fromBlock: from, toBlock: head }),
    venturePc.getLogs({ address: f, event: soldEvent, fromBlock: from, toBlock: head }),
  ]);
  launches = launches.concat(l.map((x) => ({ token: x.args.token!, creator: x.args.creator!, block: x.blockNumber! })));
  buys = buys.concat(bo.map((x) => ({ token: x.args.token!, who: x.args.buyer!, tokens: x.args.tokensOut ?? 0n, eth: x.args.ethIn ?? 0n, block: x.blockNumber! })));
  sells = sells.concat(so.map((x) => ({ token: x.args.token!, who: x.args.seller!, tokens: x.args.tokensIn ?? 0n, eth: x.args.ethOut ?? 0n, block: x.blockNumber! })));
  lastBlock = head;
  stats = computeStats(launches, buys, sells, secsPerBlock);
}

function tick() {
  if (inflight) return;
  inflight = refresh()
    .catch(() => { /* keep the last numbers; the next poll retries */ })
    .finally(() => { inflight = null; subs.forEach((fn) => fn()); });
}

/** Shared, polled curve stats for every token on the board. */
export function useCurveStats(): Map<string, CurveStats> {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    tick();
    if (!timer) timer = setInterval(() => { if (!document.hidden) tick(); }, POLL_MS);
    return () => {
      subs.delete(fn);
      if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return stats;
}
