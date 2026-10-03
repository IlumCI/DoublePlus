/** The two raise modes, and every decision that differs between them.
 *
 *  Kept apart from the components so it stays pure and testable without a
 *  chain or a DOM, in the same spirit as marketStats.ts.
 *
 *  This module exists because spreading the mode checks across the components
 *  has failed twice. `cf0eccf` added Open mode and correctly updated the
 *  transaction payload and the step-advance gate, but not the submit guards or
 *  the term sheet — which left an open curve unlaunchable behind a `required`
 *  attribute on a display:none input, and its term sheet rendering a deadline
 *  of roughly 2.1e14 days. The payload was right the whole time; presentation
 *  and validation drifted from it. One source of truth, one test file.
 */

export const GUARANTEED = 0;
export const OPEN = 1;
export type RaiseMode = typeof GUARANTEED | typeof OPEN;

export const isOpen = (mode: RaiseMode): boolean => mode === OPEN;

/** A funding target is a Guaranteed-mode concept. In Open mode the factory
 *  substitutes its own `graduationRaiseWei` and ignores whatever is sent, so
 *  demanding one blocks a launch over a field nothing reads.
 *
 *  Drives both the `required` attribute and the submit guard: a required
 *  control inside a hidden wrapper blocks native form submit while being
 *  unfocusable, so the browser cannot report which field is at fault. */
export const requiresTarget = (mode: RaiseMode): boolean => !isOpen(mode);

/** Open mode stores `type(uint64).max` as its deadline. Any UI that subtracts
 *  and divides it must not run. */
export const hasDeadline = (mode: RaiseMode): boolean => !isOpen(mode);

/** `launch()` reverts if `founderRaiseBps != 0` in Open mode: the creator is
 *  paid out of curve fees instead of a cut of the raise. */
export const takesFounderCut = (mode: RaiseMode): boolean => !isOpen(mode);

/** Open mode sets `maxBuy = type(uint256).max`, so a per-wallet cap is not a
 *  setting the founder controls there. */
export const hasWalletCap = (mode: RaiseMode): boolean => !isOpen(mode);

export type TargetIssue = "missing" | "below-floor" | null;

/** Why a target is unacceptable, or null when it is fine. Always null in Open
 *  mode, whatever the figure — including zero, which is what the wizard sends. */
export function targetIssue(mode: RaiseMode, targetEth: number, minTargetEth: number): TargetIssue {
  if (!requiresTarget(mode)) return null;
  if (!(targetEth > 0)) return "missing";
  // The same 0.1% tolerance the wizard has always used, so a figure typed to
  // match a displayed minimum is not rejected by float dust.
  if (minTargetEth > 0 && targetEth < minTargetEth * 0.999) return "below-floor";
  return null;
}

/** The smallest headline raise a founder can ask for.
 *
 *  Two floors apply and the binding one is whichever is higher:
 *
 *  - the curve cannot raise less than its own supply costs at the start price
 *    (`baseCost`), which binds the gross target, and
 *  - the platform will not finish a raise whose *pool* is below the floor,
 *    which binds the raise net of the founder's cut.
 *
 *  The second is why this takes the cut at all: `finalize()` pays the founder
 *  first and seeds the pool with the remainder, so a founder taking 30% must
 *  raise ~1.43x the floor for the pool to clear it. Quoting the bare floor here
 *  would let the wizard submit a launch the factory rejects. */
export function minGrossTargetEth(
  mode: RaiseMode,
  curveFloorEth: number,
  platformFloorEth: number,
  founderCutPct: number,
): number {
  // An open curve has no founder-set target and no cut; the protocol's own
  // graduation threshold applies instead.
  if (isOpen(mode)) return 0;
  const keep = 1 - Math.min(Math.max(founderCutPct, 0), 99) / 100;
  const grossedForPool = keep > 0 ? platformFloorEth / keep : Infinity;
  return Math.max(curveFloorEth, grossedForPool);
}

export interface RaiseInput {
  targetWei: bigint;
  days: number;
  capPct: number;
  founderCutPct: number;
}

export interface RaiseFields {
  targetRaiseWei: bigint;
  raiseDurationSecs: bigint;
  maxBuyWei: bigint;
  founderRaiseBps: number;
}

/** The four `LaunchParams` fields that differ by mode. Open mode zeroes every
 *  one: the factory substitutes `graduationRaiseWei`, `type(uint64).max` and
 *  `type(uint256).max`, and rejects a non-zero founder cut outright. */
export function raiseFields(mode: RaiseMode, input: RaiseInput): RaiseFields {
  if (isOpen(mode)) {
    return {
      targetRaiseWei: 0n,
      // Ignored by the factory, which stores type(uint64).max. Sent as a valid
      // in-range figure so the call cannot trip the Guaranteed-mode bounds
      // check if that guard is ever widened.
      raiseDurationSecs: BigInt(7 * 86_400),
      maxBuyWei: 0n,
      founderRaiseBps: 0,
    };
  }
  return {
    targetRaiseWei: input.targetWei,
    raiseDurationSecs: BigInt(input.days * 86_400),
    maxBuyWei: (input.targetWei * BigInt(Math.round(input.capPct * 100))) / 10_000n,
    founderRaiseBps: input.founderCutPct * 100,
  };
}

export interface TermValues {
  /** Pre-formatted, because formatting lives with the components. */
  targetEth: string;
  founderCutPct: string;
  days: number;
  antiSnipe: string;
}

/** Term-sheet rows, in order. Open mode drops the two rows that describe
 *  things it does not have, and relabels the target as what the figure
 *  actually is there: the protocol's graduation threshold. */
export function termSheetRows(mode: RaiseMode, v: TermValues): [string, string][] {
  const rows: [string, string][] = [
    [isOpen(mode) ? "Graduates at" : "Funding target", `${v.targetEth} ETH`],
  ];
  if (takesFounderCut(mode)) {
    rows.push(["Creator's cut of the raise", `${v.founderCutPct}%, paid at graduation`]);
  }
  if (hasDeadline(mode)) {
    rows.push(["Deadline", `${v.days} day${v.days === 1 ? "" : "s"}`]);
  }
  rows.push(["Anti-snipe", v.antiSnipe]);
  return rows;
}
