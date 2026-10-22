import { useEffect, useState } from "react";
import { parseAbiItem } from "viem";

import { boughtEvent, routedEvent, VENTURE, venturePc } from "./client";

// Platform volume over the last 24h, in ETH: curve buys and sells on the
// factory, plus pool trades through the router (Routed is ETH-denominated
// whatever the coin's pair). Polled; each poll reads only the new blocks and
// drops trades that aged out of the window.
const soldEvent = parseAbiItem(
  "event CurveSell(address indexed token, address indexed seller, uint256 ethOut, uint256 tokensIn, uint128 priceWei, uint256 feeWei)",
);
const POLL_MS = 30_000;
const DAY_SECS = 86_400;
// The RPC allows an address-filtered log query this many blocks at a time.
const CHUNK = 100_000n;

type Trade = { block: bigint; wei: bigint };
let trades: Trade[] = [];
let lastBlock = 0n;
let blocksPerDay = 0n;
let total: bigint | null = null;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

async function read(from: bigint, to: bigint): Promise<Trade[]> {
  const out: Trade[] = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = a + CHUNK - 1n < to ? a + CHUNK - 1n : to;
    const [bought, sold, routed] = await Promise.all([
      venturePc.getLogs({ address: VENTURE.factory, event: boughtEvent, fromBlock: a, toBlock: b, strict: true }),
      venturePc.getLogs({ address: VENTURE.factory, event: soldEvent, fromBlock: a, toBlock: b, strict: true }),
      venturePc.getLogs({ address: VENTURE.router, event: routedEvent, fromBlock: a, toBlock: b, strict: true }),
    ]);
    for (const l of bought) out.push({ block: l.blockNumber, wei: l.args.ethIn });
    for (const l of sold) out.push({ block: l.blockNumber, wei: l.args.ethOut });
    for (const l of routed) out.push({ block: l.blockNumber, wei: l.args.isBuy ? l.args.ethIn : l.args.ethOut });
  }
  return out;
}

async function refresh() {
  const head = await venturePc.getBlockNumber();
  if (blocksPerDay === 0n) {
    // Block time measured over the last 20k blocks, so the window is a day of
    // chain time rather than a guess at the block rate.
    const back = head > 20_000n ? head - 20_000n : 0n;
    const [a, b] = await Promise.all([venturePc.getBlock({ blockNumber: head }), venturePc.getBlock({ blockNumber: back })]);
    const secs = Number(a.timestamp - b.timestamp) / Number(head - back || 1n);
    blocksPerDay = BigInt(Math.ceil(DAY_SECS / Math.max(0.05, secs)));
  }
  const dayStart = head > blocksPerDay ? head - blocksPerDay : 0n;
  const floor = dayStart > VENTURE.startBlock ? dayStart : VENTURE.startBlock;
  const from = lastBlock === 0n ? floor : lastBlock + 1n;
  if (from <= head) trades = trades.concat(await read(from, head));
  trades = trades.filter((t) => t.block >= floor);
  lastBlock = head;
  total = trades.reduce((s, t) => s + t.wei, 0n);
}

function tick() {
  if (inflight) return;
  inflight = refresh()
    .catch(() => { /* keep the last total; the next poll retries */ })
    .finally(() => { inflight = null; subs.forEach((fn) => fn()); });
}

/** ETH traded across every coin in the last 24h, in wei; null until read. */
export function useVolume24(): bigint | null {
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
  return total;
}
