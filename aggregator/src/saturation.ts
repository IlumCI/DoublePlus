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
  /** Median seconds from launch to an open market, over the graduations we
   *  saw. Null when none completed in the window.
   *
   *  The median, not the mean: a handful of coins that sat on a curve for
   *  months would drag a mean so far that two launchpads could not be told
   *  apart. */
  medianTurnoverSecs: number | null;
  /** Turnovers per year implied by that median — Marx's `n`. Two launchpads
   *  graduating the same share of their coins are not equally good businesses
   *  if one does it in a week and the other in a quarter. */
  turnoversPerYear: number | null;
}

export interface ChainStats {
  chainId: number;
  launches: number;
  graduations: number;
  graduationRate: number | null;
  medianTurnoverSecs: number | null;
  turnoversPerYear: number | null;
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

const SECONDS_PER_YEAR = 31_557_600;

/** Median of a sorted-or-unsorted list of seconds, or null when empty. */
function medianSecs(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function perYear(medianSecs: number | null): number | null {
  return medianSecs && medianSecs > 0 ? SECONDS_PER_YEAR / medianSecs : null;
}

export function saturation(store: Store, windowDays: number, now = Math.floor(Date.now() / 1000)): SaturationReport {
  const since = now - windowDays * 86_400;
  const rows = store.countsSince(since);
  // Turnovers are grouped by chain and by source separately, because the
  // median of medians is not the median.
  const bySourceTurnover = new Map<string, number[]>();
  const byChainTurnover = new Map<number, number[]>();
  for (const t of store.turnoversSince(since)) {
    const key = `${t.chain_id}:${t.source_id}`;
    bySourceTurnover.set(key, [...(bySourceTurnover.get(key) ?? []), t.secs]);
    byChainTurnover.set(t.chain_id, [...(byChainTurnover.get(t.chain_id) ?? []), t.secs]);
  }

  const byChain = new Map<number, ChainStats>();
  for (const r of rows) {
    const launches = Number(r.launches ?? 0);
    const graduations = Number(r.graduations ?? 0);
    const chain =
      byChain.get(r.chain_id) ??
      ({
        chainId: r.chain_id,
        launches: 0,
        graduations: 0,
        graduationRate: null,
        medianTurnoverSecs: null,
        turnoversPerYear: null,
        sources: [],
      } satisfies ChainStats);
    chain.launches += launches;
    chain.graduations += graduations;
    const sourceMedian = medianSecs(bySourceTurnover.get(`${r.chain_id}:${r.source_id}`) ?? []);
    chain.sources.push({
      chainId: r.chain_id,
      sourceId: r.source_id,
      launches,
      graduations,
      graduationRate: rate(launches, graduations),
      medianTurnoverSecs: sourceMedian,
      turnoversPerYear: perYear(sourceMedian),
    });
    byChain.set(r.chain_id, chain);
  }

  const chains = [...byChain.values()]
    .map((c) => {
      const m = medianSecs(byChainTurnover.get(c.chainId) ?? []);
      return { ...c, graduationRate: rate(c.launches, c.graduations), medianTurnoverSecs: m, turnoversPerYear: perYear(m) };
    })
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
