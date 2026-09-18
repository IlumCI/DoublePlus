import type { PoolTrade } from "./client";

/** Market statistics derived from the swap log alone — no indexer, no
 *  backend, the same source the chart draws from. Kept apart from the RPC
 *  client so it stays a pure function and can be tested without a chain. */

export interface MarketStats {
  priceWei: bigint;
  vol24Wei: bigint;
  buyVol24Wei: bigint;
  sellVol24Wei: bigint;
  buys24: number;
  sells24: number;
  /** Percent change over each window, or null when the window predates the pool. */
  change: { m5: number | null; h1: number | null; h4: number | null; h24: number | null };
}

const WINDOWS = { m5: 300, h1: 3_600, h4: 14_400, h24: 86_400 } as const;

/** Everything the stat strip shows, derived from the swap log alone — no
 *  indexer, no backend, same source the chart draws from. */
export function marketStats(trades: PoolTrade[], nowSecs?: number): MarketStats {
  const now = nowSecs ?? Math.floor(Date.now() / 1000);
  const last = trades[trades.length - 1];
  const priceWei = last?.priceWei ?? 0n;

  let vol24Wei = 0n, buyVol24Wei = 0n, sellVol24Wei = 0n, buys24 = 0, sells24 = 0;
  for (const t of trades) {
    if (now - t.ts > WINDOWS.h24) continue;
    vol24Wei += t.pairAmount;
    if (t.isBuy) { buyVol24Wei += t.pairAmount; buys24++; }
    else { sellVol24Wei += t.pairAmount; sells24++; }
  }

  // The reference price for a window is the last trade at or before its start.
  // A pool younger than the window has none, so the earliest trade stands in:
  // a two-hour-old pool showing "—" for 24h helps nobody, and the change
  // since its first trade is the true answer to the same question.
  const priceAt = (cutoff: number): bigint | null => {
    let px: bigint | null = null;
    for (const t of trades) {
      if (t.ts > cutoff) break;
      px = t.priceWei;
    }
    return px ?? trades[0]?.priceWei ?? null;
  };
  const pctFrom = (secs: number): number | null => {
    if (trades.length < 2) return null; // one point is a price, not a change
    const then = priceAt(now - secs);
    if (then === null || then === 0n || priceWei === 0n) return null;
    return (Number(priceWei - then) / Number(then)) * 100;
  };

  return {
    priceWei, vol24Wei, buyVol24Wei, sellVol24Wei, buys24, sells24,
    change: { m5: pctFrom(WINDOWS.m5), h1: pctFrom(WINDOWS.h1), h4: pctFrom(WINDOWS.h4), h24: pctFrom(WINDOWS.h24) },
  };
}

/** A pool swap whose sender is the protocol itself, not a trader.
 *
 *  The fee hook swaps inside `afterSwap` to convert a founder-tax bucket into
 *  the pair token for dividends, liquidity and market-making. Those emit their
 *  own Swap events on the same pool, in the same transaction as the trade that
 *  triggered them — measured on a live graduated pool: 7 trades produced 19
 *  Swap events, 12 of them from the hook, every one sharing a tx with a router
 *  swap.
 *
 *  They are real swaps, but they are a mechanical consequence of a trade that
 *  is already counted, so counting them again double-counts the same economic
 *  activity. The distortion is almost entirely in the transaction COUNT, not
 *  in value: on that same pool the hook's 12 swaps carried 0.0000140 ETH of
 *  0.0038 ETH gross, 0.4%, leaving buy pressure at 25.6% either way. So the
 *  number this protects is "24h txns", which read 19 for 7 trades — a 2.7x
 *  overstatement of how busy the token looks, which is exactly the figure a
 *  trader skims to judge whether anything is happening. */
export function isProtocolSwap(
  sender: string,
  protocolAddresses: { hook?: string; factory?: string },
): boolean {
  const s = sender.toLowerCase();
  for (const a of [protocolAddresses.hook, protocolAddresses.factory]) {
    // An unconfigured address is the zero address; never filter on that, or a
    // misconfigured build would silently drop the whole tape.
    if (a && !/^0x0{40}$/i.test(a) && a.toLowerCase() === s) return true;
  }
  return false;
}
