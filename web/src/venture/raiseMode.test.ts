import { describe, expect, it } from "vitest";

import {
  GUARANTEED,
  OPEN,
  hasDeadline,
  hasWalletCap,
  isOpen,
  minGrossTargetEth,
  raiseFields,
  requiresTarget,
  takesFounderCut,
  targetIssue,
  termSheetRows,
  type RaiseMode,
} from "./raiseMode";

const MODES: RaiseMode[] = [GUARANTEED, OPEN];

describe("raise mode predicates", () => {
  it("separates the two modes", () => {
    expect(isOpen(OPEN)).toBe(true);
    expect(isOpen(GUARANTEED)).toBe(false);
  });

  it("makes every Guaranteed-only concept false in Open mode", () => {
    // The four things an open curve does not have. Each of these guards a
    // place that broke: the target guard, the term-sheet deadline row, the
    // founder cut the factory reverts on, and the per-wallet cap field.
    for (const p of [requiresTarget, hasDeadline, takesFounderCut, hasWalletCap]) {
      expect(p(GUARANTEED), p.name).toBe(true);
      expect(p(OPEN), p.name).toBe(false);
    }
  });
});

describe("targetIssue", () => {
  it("demands a target in Guaranteed mode", () => {
    expect(targetIssue(GUARANTEED, 0, 0.5)).toBe("missing");
    expect(targetIssue(GUARANTEED, 0.4, 0.5)).toBe("below-floor");
    expect(targetIssue(GUARANTEED, 0.5, 0.5)).toBeNull();
    expect(targetIssue(GUARANTEED, 2, 0.5)).toBeNull();
  });

  it("never blocks an open curve, whatever the figure", () => {
    // This is the regression. The wizard sends 0 for an open curve because the
    // factory ignores it; a guard that rejected 0 made the launch button do
    // nothing at all.
    for (const eth of [0, 0.0001, 0.4, 5, 1_000]) {
      expect(targetIssue(OPEN, eth, 0.5), `target ${eth}`).toBeNull();
    }
  });

  it("tolerates float dust against a displayed minimum", () => {
    // A founder who types exactly the minimum shown to them must not be told
    // it is too low.
    expect(targetIssue(GUARANTEED, 0.2413, 0.2413)).toBeNull();
    expect(targetIssue(GUARANTEED, 0.24127, 0.2413)).toBeNull();
    expect(targetIssue(GUARANTEED, 0.24, 0.2413)).toBe("below-floor");
  });

  it("accepts any positive target when there is no floor", () => {
    expect(targetIssue(GUARANTEED, 0.000001, 0)).toBeNull();
    expect(targetIssue(GUARANTEED, 0, 0)).toBe("missing");
  });
});

describe("minGrossTargetEth", () => {
  const CURVE = 0.2413; // whole curve supply at the $750 start valuation
  const FLOOR = 0.5; // the platform's pool floor

  it("grosses the platform floor up by the founder's cut", () => {
    // The bug this encodes: a 0.5 ETH raise with the maximum 30% cut graduates
    // into 0.35 ETH. To put 0.5 ETH in the pool the founder must ask for more.
    expect(minGrossTargetEth(GUARANTEED, CURVE, FLOOR, 0)).toBeCloseTo(0.5, 10);
    expect(minGrossTargetEth(GUARANTEED, CURVE, FLOOR, 20)).toBeCloseTo(0.625, 10);
    expect(minGrossTargetEth(GUARANTEED, CURVE, FLOOR, 30)).toBeCloseTo(0.714285714, 8);
  });

  it("leaves the pool at or above the floor at every cut the factory allows", () => {
    for (let cut = 0; cut <= 30; cut++) {
      const gross = minGrossTargetEth(GUARANTEED, CURVE, FLOOR, cut);
      const pool = gross * (1 - cut / 100);
      expect(pool, `cut ${cut}%`).toBeGreaterThanOrEqual(FLOOR - 1e-9);
    }
  });

  it("uses the curve's own base cost when that is the binding floor", () => {
    // A low platform floor does not license a raise the curve cannot price:
    // below baseCost the slope would go negative and launch() reverts.
    expect(minGrossTargetEth(GUARANTEED, CURVE, 0.01, 0)).toBeCloseTo(CURVE, 10);
    // …and the higher of the two always wins.
    expect(minGrossTargetEth(GUARANTEED, 2, FLOOR, 30)).toBe(2);
  });

  it("does not apply to an open curve, which has no founder-set target", () => {
    expect(minGrossTargetEth(OPEN, CURVE, FLOOR, 0)).toBe(0);
    expect(minGrossTargetEth(OPEN, CURVE, FLOOR, 30)).toBe(0);
  });

  it("clamps a nonsense cut rather than dividing by zero", () => {
    expect(Number.isFinite(minGrossTargetEth(GUARANTEED, CURVE, FLOOR, 100))).toBe(true);
    expect(minGrossTargetEth(GUARANTEED, CURVE, FLOOR, -5)).toBeCloseTo(0.5, 10);
  });
});

describe("raiseFields", () => {
  const input = { targetWei: 5n * 10n ** 18n, days: 14, capPct: 2, founderCutPct: 20 };

  it("passes the founder's terms through in Guaranteed mode", () => {
    expect(raiseFields(GUARANTEED, input)).toEqual({
      targetRaiseWei: 5n * 10n ** 18n,
      raiseDurationSecs: BigInt(14 * 86_400),
      maxBuyWei: (5n * 10n ** 18n * 200n) / 10_000n, // 2% of target
      founderRaiseBps: 2_000,
    });
  });

  it("zeroes every Guaranteed-only field in Open mode", () => {
    const f = raiseFields(OPEN, input);
    expect(f.targetRaiseWei).toBe(0n);
    expect(f.maxBuyWei).toBe(0n);
    // launch() reverts outright if this is non-zero on an open curve.
    expect(f.founderRaiseBps).toBe(0);
  });

  it("ignores the founder's inputs entirely in Open mode", () => {
    const a = raiseFields(OPEN, input);
    const b = raiseFields(OPEN, { targetWei: 99n, days: 1, capPct: 90, founderCutPct: 30 });
    expect(a).toEqual(b);
  });

  it("keeps raiseDurationSecs inside the factory's 1..14 day bounds", () => {
    // Guaranteed mode is bounds-checked on chain (MIN_RAISE_SECS/MAX_RAISE_SECS).
    // Open mode is not, but sending an in-range value costs nothing and means
    // the call still succeeds if that guard is ever widened to both modes.
    const secs = Number(raiseFields(OPEN, input).raiseDurationSecs);
    expect(secs).toBeGreaterThanOrEqual(86_400);
    expect(secs).toBeLessThanOrEqual(14 * 86_400);
  });

  it("scales the per-wallet cap off the target, not a constant", () => {
    const f = raiseFields(GUARANTEED, { ...input, targetWei: 10n ** 18n, capPct: 5 });
    expect(f.maxBuyWei).toBe((10n ** 18n * 500n) / 10_000n);
  });
});

describe("termSheetRows", () => {
  const v = { targetEth: "0.005", founderCutPct: "20.0", days: 14, antiSnipe: "15% for 5s" };
  const keys = (mode: RaiseMode) => termSheetRows(mode, v).map(([k]) => k);

  it("shows the full sheet for a funded raise", () => {
    expect(keys(GUARANTEED)).toEqual([
      "Funding target",
      "Creator's cut of the raise",
      "Deadline",
      "Anti-snipe",
    ]);
  });

  it("drops the rows an open curve does not have", () => {
    // The deadline row is the regression: the factory stores type(uint64).max
    // there, and rendering it as days produced ~2.1e14.
    expect(keys(OPEN)).toEqual(["Graduates at", "Anti-snipe"]);
    expect(keys(OPEN)).not.toContain("Deadline");
    expect(keys(OPEN)).not.toContain("Creator's cut of the raise");
  });

  it("relabels the target as the graduation threshold in Open mode", () => {
    expect(termSheetRows(OPEN, v)[0]).toEqual(["Graduates at", "0.005 ETH"]);
    expect(termSheetRows(GUARANTEED, v)[0]).toEqual(["Funding target", "0.005 ETH"]);
  });

  it("keeps anti-snipe last in both modes: it is mode-independent", () => {
    for (const m of MODES) {
      const rows = termSheetRows(m, v);
      expect(rows[rows.length - 1][0], `mode ${m}`).toBe("Anti-snipe");
    }
  });

  it("pluralises the deadline", () => {
    const one = termSheetRows(GUARANTEED, { ...v, days: 1 });
    expect(one.find(([k]) => k === "Deadline")?.[1]).toBe("1 day");
    expect(termSheetRows(GUARANTEED, v).find(([k]) => k === "Deadline")?.[1]).toBe("14 days");
  });
});

describe("the modes stay consistent with each other", () => {
  it("never shows a row for a field it zeroes", () => {
    // The invariant both bugs violated: presentation and payload must agree
    // about what a mode has. If a future mode zeroes a field, this fails until
    // the term sheet stops claiming it.
    for (const m of MODES) {
      const f = raiseFields(m, { targetWei: 5n * 10n ** 18n, days: 14, capPct: 2, founderCutPct: 20 });
      const shown = termSheetRows(m, { targetEth: "5", founderCutPct: "20.0", days: 14, antiSnipe: "x" })
        .map(([k]) => k);
      if (f.founderRaiseBps === 0) expect(shown, `mode ${m}`).not.toContain("Creator's cut of the raise");
      if (!hasDeadline(m)) expect(shown, `mode ${m}`).not.toContain("Deadline");
    }
  });

  it("only demands a target for a mode that actually sends one", () => {
    for (const m of MODES) {
      const f = raiseFields(m, { targetWei: 5n * 10n ** 18n, days: 14, capPct: 2, founderCutPct: 20 });
      if (f.targetRaiseWei === 0n) {
        expect(requiresTarget(m), `mode ${m}`).toBe(false);
        expect(targetIssue(m, 0, 0.5), `mode ${m}`).toBeNull();
      }
    }
  });
});
