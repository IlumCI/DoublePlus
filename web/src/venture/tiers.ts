/** Holder tiers for tiered-dividend coins: the same ladder QuiverToken's
 *  tierMultiplierBps applies, plus a rough daily-earnings estimate per step.
 *  Pure, like marketStats.ts, so it can be tested without a chain. */

/** [multiple of the minimum hold, multiplier in bps], lowest step first. */
export const TIERS: readonly { min: bigint; bps: bigint }[] = [
  { min: 1n, bps: 10_000n },
  { min: 3n, bps: 15_000n },
  { min: 10n, bps: 20_000n },
  { min: 30n, bps: 30_000n },
  { min: 100n, bps: 50_000n },
  { min: 300n, bps: 75_000n },
  { min: 1000n, bps: 100_000n },
];

/** Index into TIERS for a balance, or -1 under the minimum. */
export function tierIndex(balance: bigint, floor: bigint): number {
  if (floor === 0n || balance < floor) return -1;
  const m = balance / floor;
  for (let i = TIERS.length - 1; i >= 0; i--) if (m >= TIERS[i].min) return i;
  return 0;
}

/** Holder dividends the last 24h of trading would pay in a day, in pair wei:
 *  each side's volume times its tax times the dividend bucket. */
export function dailyDividendsWei(
  buyVolWei: bigint, sellVolWei: bigint,
  policy: { buyTaxBps: number; sellTaxBps: number; dividendBps: number },
): bigint {
  const tax = buyVolWei * BigInt(policy.buyTaxBps) + sellVolWei * BigInt(policy.sellTaxBps);
  return (tax * BigInt(policy.dividendBps)) / 100_000_000n;
}

export interface TierRow {
  /** Multiplier, e.g. 7.5. */
  mult: number;
  /** Tokens needed to reach the step (wei). */
  holdWei: bigint;
  /** Estimated daily earnings for a wallet holding exactly that, in pair wei. */
  dailyWei: bigint;
}

/** One row per step, top tier first (the pyramid's apex). A wallet holding a
 *  step's threshold adds its own weight to the pool, so its share is
 *  w / (eligible + w); `eligible` is the token's eligibleSupply. */
export function tierRows(floor: bigint, eligible: bigint, dailyWei: bigint): TierRow[] {
  return TIERS.map((t) => {
    const holdWei = floor * t.min;
    const w = (holdWei * t.bps) / 10_000n;
    const dailyOut = w + eligible > 0n ? (dailyWei * w) / (eligible + w) : 0n;
    return { mult: Number(t.bps) / 10_000, holdWei, dailyWei: dailyOut };
  }).reverse();
}
