import type { Address } from "viem";

/**
 * The due-diligence numbers traders otherwise go to a terminal for, computed
 * from the factory's own curve events: who bought, how concentrated the
 * curve's buyers are, whether the creator bought their own coin, and how the
 * first minute went (the strongest single predictor of graduation in the
 * pump.fun studies). Curve activity only: transfers and pool trades after
 * graduation are not counted, and the card says "on the curve".
 *
 * Pure and chain-free so it tests without an RPC; boardStats.ts feeds it.
 */

export interface CurveStats {
  /** Unique buyers, creator excluded. */
  buyers: number;
  /** Share of net curve tokens held by the ten largest net buyers, 0..100. */
  top10Pct: number;
  /** Share of net curve tokens bought by the creator's own wallet, 0..100. */
  devPct: number;
  /** Unique buyers and ETH in during the first 60 seconds. */
  firstMinBuyers: number;
  firstMinEth: bigint;
  /** A non-creator bought in the launch block itself. */
  sniped: boolean;
}

export interface LaunchLog { token: Address; creator: Address; block: bigint }
export interface TradeLog { token: Address; who: Address; tokens: bigint; eth: bigint; block: bigint }

/** Pure: event lists in, stats per token (lowercased address) out. */
export function computeStats(
  launches: LaunchLog[], buys: TradeLog[], sells: TradeLog[], secsPerBlock: number,
): Map<string, CurveStats> {
  const firstMinBlocks = BigInt(Math.max(1, Math.round(60 / Math.max(secsPerBlock, 0.01))));
  const meta = new Map(launches.map((l) => [l.token.toLowerCase(), l]));
  const net = new Map<string, Map<string, bigint>>();
  const out = new Map<string, CurveStats>();
  const firstMin = new Map<string, Set<string>>();
  const stat = (t: string) => {
    let s = out.get(t);
    if (!s) { s = { buyers: 0, top10Pct: 0, devPct: 0, firstMinBuyers: 0, firstMinEth: 0n, sniped: false }; out.set(t, s); }
    return s;
  };
  const bump = (t: string, who: string, d: bigint) => {
    let m = net.get(t);
    if (!m) { m = new Map(); net.set(t, m); }
    m.set(who, (m.get(who) ?? 0n) + d);
  };

  for (const b of buys) {
    const t = b.token.toLowerCase(), who = b.who.toLowerCase();
    const l = meta.get(t);
    const s = stat(t);
    bump(t, who, b.tokens);
    const isDev = l && who === l.creator.toLowerCase();
    if (l && !isDev) {
      if (b.block === l.block) s.sniped = true;
      if (b.block - l.block <= firstMinBlocks) {
        let set = firstMin.get(t);
        if (!set) { set = new Set(); firstMin.set(t, set); }
        set.add(who);
        s.firstMinEth += b.eth;
      }
    }
  }
  for (const x of sells) bump(x.token.toLowerCase(), x.who.toLowerCase(), -x.tokens);

  for (const [t, m] of net) {
    const s = stat(t);
    const creator = meta.get(t)?.creator.toLowerCase();
    const holders = [...m.entries()].filter(([, v]) => v > 0n);
    const total = holders.reduce((a, [, v]) => a + v, 0n);
    s.buyers = new Set(buys.filter((b) => b.token.toLowerCase() === t && b.who.toLowerCase() !== creator).map((b) => b.who.toLowerCase())).size;
    s.firstMinBuyers = firstMin.get(t)?.size ?? 0;
    if (total > 0n) {
      const top = holders.map(([, v]) => v).sort((a, b) => (b > a ? 1 : b < a ? -1 : 0)).slice(0, 10).reduce((a, v) => a + v, 0n);
      s.top10Pct = Number((top * 10_000n) / total) / 100;
      const dev = creator ? m.get(creator) ?? 0n : 0n;
      s.devPct = dev > 0n ? Number((dev * 10_000n) / total) / 100 : 0;
    }
  }
  return out;
}
