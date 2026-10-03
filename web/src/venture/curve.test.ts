import { describe, expect, it } from "vitest";

import {
  capState,
  curveCostWei,
  entryFeeWei,
  feePct,
  curveFeeWei,
  gradValueWei,
  quoteBuy,
  quoteSellWei,
  quoteTokens,
  sqrtBig,
  taxPct,
  type CurveState,
} from "./curve";
import { GUARANTEED, OPEN } from "./raiseMode";

const ETH = 10n ** 18n;

/** A curve shaped like a real launch: 600M tokens, priced so the whole curve
 *  raises `targetEth` starting from `p0`. Mirrors how VentureFactory solves
 *  for the slope at launch. */
function curve(opts: Partial<CurveState> = {}): CurveState {
  const CURVE_SUPPLY = 600_000_000n;
  const p0 = 1_000_000_000n; // wei per whole token
  const target = 2n * ETH;
  const base = p0 * CURVE_SUPPLY;
  const slopeQ = ((2n * (target - base)) * ETH) / (CURVE_SUPPLY * CURVE_SUPPLY);
  return {
    mode: GUARANTEED,
    basePriceWei: p0,
    slopeQ,
    soldWhole: 0n,
    remainingWhole: CURVE_SUPPLY,
    ...opts,
  };
}

describe("sqrtBig", () => {
  it("is the integer square root", () => {
    expect(sqrtBig(0n)).toBe(0n);
    expect(sqrtBig(1n)).toBe(1n);
    expect(sqrtBig(4n)).toBe(2n);
    expect(sqrtBig(8n)).toBe(2n); // floors
    expect(sqrtBig(10n ** 36n)).toBe(10n ** 18n);
  });

  it("never overshoots", () => {
    for (const n of [2n, 3n, 99n, 10n ** 20n + 7n, 2n ** 128n - 1n]) {
      const r = sqrtBig(n);
      expect(r * r <= n, `${n}`).toBe(true);
      expect((r + 1n) * (r + 1n) > n, `${n}`).toBe(true);
    }
  });
});

describe("curveCostWei", () => {
  it("is zero for a non-positive quantity", () => {
    expect(curveCostWei(curve(), 0n, 0n)).toBe(0n);
    expect(curveCostWei(curve(), -5n, 0n)).toBe(0n);
  });

  it("is the flat product when the curve has no slope", () => {
    const flat = curve({ slopeQ: 0n });
    expect(curveCostWei(flat, 1_000n, 0n)).toBe(1_000n * flat.basePriceWei);
  });

  it("costs more further along the curve: price only rises", () => {
    const c = curve();
    const early = curveCostWei(c, 1_000_000n, 0n);
    const later = curveCostWei(c, 1_000_000n, 300_000_000n);
    expect(later).toBeGreaterThan(early);
  });

  it("is additive to within the truncation of each slice", () => {
    // Integer division floors once per call, so N slices can come in up to N-1
    // wei under the single-buy cost — never over. That direction matters: it is
    // why a raise filled in slices lands fractionally short of target, which is
    // the stall finalize() now tolerates by one token's price (3ecf930).
    const c = curve();
    const whole = curveCostWei(c, 2_000_000n, 0n);
    const first = curveCostWei(c, 1_000_000n, 0n);
    const second = curveCostWei(c, 1_000_000n, 1_000_000n);
    expect(first + second).toBeLessThanOrEqual(whole);
    expect(whole - (first + second)).toBeLessThanOrEqual(1n);
  });
});

describe("quoteTokens", () => {
  it("returns nothing for nothing", () => {
    expect(quoteTokens(curve(), 0n)).toBe(0n);
    expect(quoteTokens(curve(), -1n)).toBe(0n);
  });

  it("inverts curveCostWei: what it quotes is affordable", () => {
    const c = curve();
    for (const spend of [ETH / 100n, ETH / 10n, ETH, 2n * ETH]) {
      const q = quoteTokens(c, spend);
      expect(curveCostWei(c, q, c.soldWhole) <= spend, `spend ${spend}`).toBe(true);
      // and it is maximal: one more token would cost more than was offered
      expect(curveCostWei(c, q + 1n, c.soldWhole) > spend, `spend ${spend}`).toBe(true);
    }
  });

  it("is path-independent: splitting a buy changes nothing", () => {
    // The property the contract's own unit test asserts. If this drifts, the
    // panel quotes a different fill than the transaction produces.
    const c = curve();
    const lump = quoteTokens(c, ETH);
    let sold = 0n;
    let got = 0n;
    for (let i = 0; i < 10; i++) {
      const step = quoteTokens({ ...c, soldWhole: sold, remainingWhole: c.remainingWhole - sold }, ETH / 10n);
      got += step;
      sold += step;
    }
    // Rounding down ten times loses at most ten tokens against one buy.
    expect(lump - got).toBeGreaterThanOrEqual(0n);
    expect(lump - got).toBeLessThanOrEqual(10n);
  });

  it("never quotes more than the curve has left", () => {
    const nearlyOut = curve({ soldWhole: 599_999_000n, remainingWhole: 1_000n });
    expect(quoteTokens(nearlyOut, 1_000n * ETH)).toBe(1_000n);
  });

  it("handles a zero-slope curve without dividing by zero", () => {
    const flat = curve({ slopeQ: 0n });
    expect(quoteTokens(flat, flat.basePriceWei * 5n)).toBe(5n);
  });
});

describe("entryFeeWei", () => {
  it("is the stated percentage of what you send", () => {
    expect(entryFeeWei(ETH, 50)).toBe(ETH / 200n); // 0.5%
    expect(entryFeeWei(ETH, 100)).toBe(ETH / 100n); // 1%
    expect(entryFeeWei(ETH, 0)).toBe(0n);
  });

  it("is zero for a non-positive amount", () => {
    expect(entryFeeWei(0n, 50)).toBe(0n);
    expect(entryFeeWei(-1n, 50)).toBe(0n);
  });
});

describe("quoteBuy", () => {
  it("takes the fee off the top, then buys with the remainder", () => {
    // The ordering matters: the contract charges the fee before quoting, so
    // spentWei records net escrow and sum(spentWei) == raisedWei holds. A panel
    // that quoted on the gross would promise tokens the buy cannot deliver.
    const c = curve();
    const q = quoteBuy(c, ETH, 50);
    expect(q.fee).toBe(ETH / 200n);
    expect(q.net).toBe(ETH - q.fee);
    expect(q.tokensOut).toBe(quoteTokens(c, q.net));
    expect(q.tokensOut).toBeLessThan(quoteTokens(c, ETH));
  });

  it("charges nothing and returns nothing at zero", () => {
    expect(quoteBuy(curve(), 0n, 50)).toEqual({ fee: 0n, net: 0n, tokensOut: 0n });
  });

  it("never lets the fee exceed the value sent", () => {
    const q = quoteBuy(curve(), 1n, 50); // fee rounds to 0 on 1 wei
    expect(q.net).toBeGreaterThanOrEqual(0n);
    expect(q.fee + q.net).toBeLessThanOrEqual(1n);
  });
});

describe("quoteSellWei — the Guaranteed cost-basis cap", () => {
  // The solvency constraint from the design doc: refunds stay funded if and
  // only if gross sell proceeds never exceed the basis of the tokens sold.
  const sold = curve({ soldWhole: 200_000_000n, remainingWhole: 400_000_000n });

  it("pays nothing for nothing", () => {
    expect(quoteSellWei(sold, 0n, ETH, ETH, 100)).toEqual({ gross: 0n, fee: 0n, out: 0n, capped: false });
    expect(quoteSellWei(sold, 100n, 0n, 0n, 100)).toEqual({ gross: 0n, fee: 0n, out: 0n, capped: false });
  });

  // Sell the whole holding, so the pro-rata basis is the whole basis and the
  // comparison is against the curve price directly. Derived from the curve
  // rather than hardcoded, so the fixture can change without silently making
  // these assertions vacuous.
  const Q = 1_000_000n;
  const OWNED = Q * ETH;
  const CURVE_VALUE = curveCostWei(sold, Q, sold.soldWhole - Q);

  it("caps a profitable exit at cost basis in Guaranteed mode", () => {
    // Bought early and cheap; the curve has since risen above what was paid.
    const basis = CURVE_VALUE / 2n;
    const r = quoteSellWei(sold, Q, OWNED, basis, 100);
    expect(r.capped).toBe(true);
    expect(r.gross).toBe(basis);
    // This is the rug the cap exists to prevent: without it the seller takes
    // later backers' ETH and the escrow is short at refund time.
    expect(r.gross).toBeLessThan(CURVE_VALUE);
  });

  it("does NOT cap the same trade on an open curve", () => {
    const basis = CURVE_VALUE / 2n;
    const r = quoteSellWei({ ...sold, mode: OPEN }, Q, OWNED, basis, 100);
    expect(r.capped).toBe(false);
    expect(r.gross).toBe(CURVE_VALUE);
    // Real profit, which is the whole point of the mode.
    expect(r.gross).toBeGreaterThan(basis);
  });

  it("leaves a losing exit uncapped in both modes: the cap is a ceiling", () => {
    const basis = CURVE_VALUE * 2n; // paid more than the curve is worth now
    for (const mode of [GUARANTEED, OPEN] as const) {
      const r = quoteSellWei({ ...sold, mode }, Q, OWNED, basis, 100);
      expect(r.capped, `mode ${mode}`).toBe(false);
      expect(r.gross, `mode ${mode}`).toBe(CURVE_VALUE);
      expect(r.gross, `mode ${mode}`).toBeLessThan(basis);
    }
  });

  it("prorates the basis by the fraction sold", () => {
    const owned = 1_000_000n * ETH;
    const basis = ETH;
    const half = quoteSellWei(sold, 500_000n, owned, basis, 0);
    expect(half.gross).toBeLessThanOrEqual(basis / 2n);
  });

  it("takes the exit fee out of the proceeds", () => {
    const r = quoteSellWei(sold, 1_000_000n, 1_000_000n * ETH, 100n * ETH, 100);
    expect(r.fee).toBe((r.gross * 100n) / 10_000n);
    expect(r.out).toBe(r.gross - r.fee);
  });

  it("never pays out more than gross", () => {
    for (const bps of [0, 50, 100, 300]) {
      const r = quoteSellWei(sold, 1_000_000n, 1_000_000n * ETH, 100n * ETH, bps);
      expect(r.out, `bps ${bps}`).toBeLessThanOrEqual(r.gross);
      expect(r.out, `bps ${bps}`).toBeGreaterThanOrEqual(0n);
    }
  });

  it("cannot sell back more than the curve has sold", () => {
    const r = quoteSellWei(sold, 999_999_999n, 1_000_000_000n * ETH, 1_000n * ETH, 0);
    expect(r.gross).toBe(curveCostWei(sold, sold.soldWhole, 0n));
  });

  it("a round trip never comes out ahead", () => {
    // The anti-churn property: buy then immediately sell must lose the fees.
    const c = curve();
    const spend = ETH;
    const { net, tokensOut } = quoteBuy(c, spend, 50);
    const after = { ...c, soldWhole: c.soldWhole + tokensOut, remainingWhole: c.remainingWhole - tokensOut };
    const back = quoteSellWei(after, tokensOut, tokensOut * ETH, net, 100);
    expect(back.out).toBeLessThan(spend);
  });
});

describe("capState", () => {
  it("treats a zero cap as no cap: an open curve has none", () => {
    expect(capState(0n, 5n * ETH, 1_000n * ETH)).toEqual({ capLeft: 0n, overCap: false });
  });

  it("blocks a buy over the remaining headroom", () => {
    expect(capState(ETH, 0n, 2n * ETH).overCap).toBe(true);
    expect(capState(ETH, 0n, ETH).overCap).toBe(false);
  });

  it("counts what was already spent", () => {
    const s = capState(ETH, (ETH * 9n) / 10n, ETH / 5n);
    expect(s.capLeft).toBe(ETH / 10n);
    expect(s.overCap).toBe(true);
  });

  it("clamps headroom at zero once the cap is used up", () => {
    expect(capState(ETH, 3n * ETH, 1n).capLeft).toBe(0n);
    expect(capState(ETH, 3n * ETH, 1n).overCap).toBe(true);
  });
});

describe("fee formatting", () => {
  it("shows the protocol fee at two decimals", () => {
    // 0.55% at one decimal rounds to 0.6%, which is what the trade panel used
    // to print — a number the contract never charges.
    expect(feePct(55)).toBe("0.55");
    expect(feePct(50)).toBe("0.50");
    expect(feePct(100)).toBe("1.00");
    expect(feePct(0)).toBe("0.00");
  });

  it("shows founder tax at one decimal", () => {
    expect(taxPct(250)).toBe("2.5");
    expect(taxPct(400)).toBe("4.0");
    expect(taxPct(0)).toBe("0.0");
  });
});

describe("gradValueWei", () => {
  it("prices a bag at the curve's closing price, above what it cost early on", () => {
    const v = curve();
    const q = 50_000_000n;
    const cost = curveCostWei(v, q, 0n);
    const atGrad = gradValueWei(v, q);
    // The closing price is the top of the curve, so an early bag is worth more there.
    expect(atGrad).toBeGreaterThan(cost);
    // And it equals the marginal price at the sold-out point times the bag.
    const endPrice = curveCostWei(v, 1n, 600_000_000n - 1n);
    expect(Number(atGrad) / Number(q * endPrice)).toBeCloseTo(1, 3);
  });
});

describe("curveFeeWei", () => {
  it("takes 10% off for a referred wallet, rounding as the contract does", () => {
    const v = 123_456_789_000_000n;
    const plain = curveFeeWei(v, 50);
    expect(plain).toBe((v * 50n) / 10_000n);
    expect(curveFeeWei(v, 50, true)).toBe(plain - (plain * 1_000n) / 10_000n);
  });
});
