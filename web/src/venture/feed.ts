import { useEffect, useState } from "react";
import { parseAbiItem, type Address } from "viem";

import { boughtEvent, routedEvent, VENTURE, venturePc } from "./client";

/**
 * The live tape: every launch, curve buy/sell, graduation and post-graduation
 * trade, read from the chain. Nothing here is synthesized — a quiet board
 * shows a quiet tape. One polled copy is shared by every component.
 */

export type FeedKind = "launch" | "buy" | "sell" | "graduate";
export interface FeedItem {
  kind: FeedKind;
  token: Address;
  who: Address | null;
  /** ETH moved (raise for a graduation, spend for a buy, proceeds for a sell). */
  eth: bigint;
  block: number;
  ts: number; // unix seconds, estimated from the block number
  key: string;
}

const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, uint256 targetRaiseWei, uint64 deadline, address vesting)",
);
const soldEvent = parseAbiItem(
  "event CurveSell(address indexed token, address indexed seller, uint256 ethOut, uint256 tokensIn, uint128 priceWei, uint256 feeWei)",
);
const graduatedEvent = parseAbiItem(
  "event Graduated(address indexed token, bytes32 poolId, uint256 raisedWei, uint256 founderCutWei, uint256 pairSeeded)",
);

const KEEP = 40;
const POLL_MS = 10_000;
// First read looks back this far, widening if a window was empty (finally to
// the factory's deploy block), so a quiet chain still shows its last events.
const LOOKBACKS = [200_000n, 2_000_000n, null];

let items: FeedItem[] = [];
let lastBlock = 0n;
let secsPerBlock = 0.25;
let anchor = { block: 0n, ts: 0 };
let loaded = false;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

const tsOf = (block: bigint) => Math.round(anchor.ts - Number(anchor.block - block) * secsPerBlock);

async function calibrate(head: bigint) {
  const back = head > 20_000n ? head - 20_000n : 0n;
  const [a, b] = await Promise.all([venturePc.getBlock({ blockNumber: head }), venturePc.getBlock({ blockNumber: back })]);
  anchor = { block: head, ts: Number(a.timestamp) };
  if (head > back) secsPerBlock = Math.max(0.05, (Number(a.timestamp) - Number(b.timestamp)) / Number(head - back));
}

async function read(from: bigint, to: bigint): Promise<FeedItem[]> {
  const f = VENTURE.factory;
  const [launched, bought, sold, grads, routed] = await Promise.all([
    venturePc.getLogs({ address: f, event: launchedEvent, fromBlock: from, toBlock: to }),
    venturePc.getLogs({ address: f, event: boughtEvent, fromBlock: from, toBlock: to }),
    venturePc.getLogs({ address: f, event: soldEvent, fromBlock: from, toBlock: to }),
    venturePc.getLogs({ address: f, event: graduatedEvent, fromBlock: from, toBlock: to }),
    venturePc.getLogs({ address: VENTURE.router, event: routedEvent, fromBlock: from, toBlock: to }),
  ]);
  const out: FeedItem[] = [];
  const key = (l: { transactionHash: string | null; logIndex: number | null }) => `${l.transactionHash}:${l.logIndex}`;
  for (const l of launched) out.push({ kind: "launch", token: l.args.token!, who: l.args.creator!, eth: l.args.targetRaiseWei ?? 0n, block: Number(l.blockNumber), ts: tsOf(l.blockNumber!), key: key(l) });
  for (const l of bought) out.push({ kind: "buy", token: l.args.token!, who: l.args.buyer!, eth: l.args.ethIn ?? 0n, block: Number(l.blockNumber), ts: tsOf(l.blockNumber!), key: key(l) });
  for (const l of sold) out.push({ kind: "sell", token: l.args.token!, who: l.args.seller!, eth: l.args.ethOut ?? 0n, block: Number(l.blockNumber), ts: tsOf(l.blockNumber!), key: key(l) });
  for (const l of grads) out.push({ kind: "graduate", token: l.args.token!, who: null, eth: l.args.raisedWei ?? 0n, block: Number(l.blockNumber), ts: tsOf(l.blockNumber!), key: key(l) });
  for (const l of routed) {
    const buy = !!l.args.isBuy;
    out.push({ kind: buy ? "buy" : "sell", token: l.args.coin!, who: l.args.trader!, eth: buy ? l.args.ethIn ?? 0n : l.args.ethOut ?? 0n, block: Number(l.blockNumber), ts: tsOf(l.blockNumber!), key: key(l) });
  }
  return out;
}

async function refresh() {
  const head = await venturePc.getBlockNumber();
  if (!loaded) {
    await calibrate(head);
    let found: FeedItem[] = [];
    for (const span of LOOKBACKS) {
      const from = span === null ? VENTURE.startBlock : head > span ? head - span : 0n;
      found = await read(from < VENTURE.startBlock ? VENTURE.startBlock : from, head);
      if (found.length > 0) break;
    }
    items = found.sort((a, b) => b.block - a.block).slice(0, KEEP);
    loaded = true;
  } else if (head > lastBlock) {
    anchor = { block: head, ts: Math.round(Date.now() / 1000) };
    const fresh = await read(lastBlock + 1n, head);
    if (fresh.length) {
      const seen = new Set(items.map((i) => i.key));
      items = [...fresh.filter((i) => !seen.has(i.key)), ...items].sort((a, b) => b.block - a.block).slice(0, KEEP);
    }
  }
  lastBlock = head;
}

function tick() {
  if (inflight) return;
  inflight = refresh()
    .catch(() => { /* a failed poll keeps the last tape; the next one retries */ })
    .finally(() => { inflight = null; subs.forEach((f) => f()); });
}

export function useLiveFeed(): { items: FeedItem[]; loaded: boolean } {
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
  return { items, loaded };
}

/** Tokens with a buy inside the last `secs` seconds: the honest "hot" signal. */
export function hotTokens(feed: FeedItem[], secs = 900): Set<string> {
  const cutoff = Date.now() / 1000 - secs;
  return new Set(feed.filter((i) => i.kind === "buy" && i.ts >= cutoff).map((i) => i.token.toLowerCase()));
}
