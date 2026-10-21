/** The saturation measure: how crowded a kind of launch is right now.
 *
 *  This is what the foundry's selection loop divides fee income by. Its
 *  accuracy decides whether the loop can tell a format that still pays from
 *  one that everybody has copied, so what it can and cannot see is worth
 *  stating plainly.
 *
 *  **What is observable.** For every launchpad, ours or not: how many coins it
 *  launched in a window, and how many of those reached an open market. That is
 *  read from its own events and is exact.
 *
 *  **What is not.** A third-party coin's terms — its tax split, its dividend
 *  policy, the profile of whatever its creator was imitating — are not in its
 *  launch event, and often not on chain at all. So rival counts cannot be
 *  keyed by the foundry's exact format key for anyone else's coins.
 *
 *  The projection used instead: a format's rivals are **every coin launched on
 *  the same chain in the window**, across all indexed launchpads. It is
 *  deliberately coarse in the safe direction. It overstates competition rather
 *  than understating it, so the loop retreats from a crowded chain early
 *  instead of discovering saturation by losing money on it. Our own coins are
 *  additionally counted exactly, by their own format, inside the foundry.
 *
 *  The graduation rate is reported alongside, because it is the better signal
 *  of whether a chain's launches are reaching anything: a chain minting
 *  thousands of coins that never graduate is saturated however high its launch
 *  count is. */

import type { Store } from "./db.js";

export interface SourceStats {
  chainId: number;
  sourceId: string;
  launches: number;
  graduations: number;
  /** Graduations per launch in the window, or null when nothing launched. */
  graduationRate: number | null;
}

export interface ChainStats {
  chainId: number;
  launches: number;
  graduations: number;
  graduationRate: number | null;
  sources: SourceStats[];
}

export interface SaturationReport {
  windowDays: number;
  /** Unix seconds the window starts at. */
  since: number;
  chains: ChainStats[];
  /** What the foundry consumes: chain id -> coins launched in the window.
   *  The projection described above. */
  rivalsByChain: Record<string, number>;
  totals: { coins: number; graduated: number }[];
}

function rate(launches: number, graduations: number): number | null {
  return launches > 0 ? graduations / launches : null;
}

export function saturation(store: Store, windowDays: number, now = Math.floor(Date.now() / 1000)): SaturationReport {
  const since = now - windowDays * 86_400;
  const rows = store.countsSince(since);

  const byChain = new Map<number, ChainStats>();
  for (const r of rows) {
    const launches = Number(r.launches ?? 0);
    const graduations = Number(r.graduations ?? 0);
    const chain =
      byChain.get(r.chain_id) ??
      ({ chainId: r.chain_id, launches: 0, graduations: 0, graduationRate: null, sources: [] } satisfies ChainStats);
    chain.launches += launches;
    chain.graduations += graduations;
    chain.sources.push({
      chainId: r.chain_id,
      sourceId: r.source_id,
      launches,
      graduations,
      graduationRate: rate(launches, graduations),
    });
    byChain.set(r.chain_id, chain);
  }

  const chains = [...byChain.values()]
    .map((c) => ({ ...c, graduationRate: rate(c.launches, c.graduations) }))
    .sort((a, b) => b.launches - a.launches);

  const rivalsByChain: Record<string, number> = {};
  for (const c of chains) rivalsByChain[String(c.chainId)] = c.launches;

  return {
    windowDays,
    since,
    chains,
    rivalsByChain,
    totals: store.totals().map((t) => ({ ...t, coins: Number(t.coins), graduated: Number(t.graduated ?? 0) })),
  };
}
