import { describe, expect, it } from "vitest";

import { curveCostWei, type CurveState } from "./curve";
import { curveValue, marketValue, position } from "./pnl";
import { GUARANTEED, OPEN } from "./raiseMode";

const ETH = 10n ** 18n;
const none = { curveIn: 0n, curveOut: 0n, routerIn: 0n, routerOut: 0n };

function curve(soldWhole: bigint, mode: CurveState["mode"] = GUARANTEED): CurveState {
  const C = 600_000_000n, p0 = 1_000_000_000n, target = 2n * ETH;
  const slopeQ = ((2n * (target - p0 * C)) * ETH) / (C * C);
  return { mode, basePriceWei: p0, slopeQ, soldWhole, remainingWhole: C - soldWhole };
}

describe("position", () => {
  it("is profit when value plus withdrawals beat what went in", () => {
    const p = position({ ...none, curveIn: ETH, routerOut: ETH / 2n }, ETH, "market");
    expect(p.pnl).toBe(ETH / 2n);
    expect(p.pnlPct).toBeCloseTo(50);
  });

  it("is a loss when the position is worth less than it cost", () => {
    const p = position({ ...none, routerIn: 2n * ETH }, ETH, "market");
    expect(p.pnl).toBe(-ETH);
    expect(p.pnlPct).toBeCloseTo(-50);
  });

  it("reports no P&L when the value is unknown or nothing was paid", () => {
    expect(position({ ...none, curveIn: ETH }, null, "none").pnl).toBeNull();
    expect(position(none, ETH, "market").pnl).toBeNull(); // tokens received for free
  });
});

describe("curveValue", () => {
  it("never pays more than was put in on a refund raise, even after the price ran", () => {
    // Bought the first 100M, then the curve ran to 500M sold.
    const bought = 100_000_000n;
    const spent = curveCostWei(curve(0n), bought, 0n);
    const v = curveValue(curve(500_000_000n), bought * ETH, spent, 100);
    expect(v).toBe(spent - (spent * 100n) / 10_000n);
  });

  it("pays the live curve price on an open curve, which can be a profit", () => {
    const bought = 100_000_000n;
    const spent = curveCostWei(curve(0n, OPEN), bought, 0n);
    expect(curveValue(curve(500_000_000n, OPEN), bought * ETH, spent, 100)).toBeGreaterThan(spent);
  });
});

describe("marketValue", () => {
  it("prices the balance at the pool tick, less the sell fees", () => {
    // tick 0 is a price of 1 either way round.
    expect(marketValue(10n * ETH, 0, true, 0)).toBe(10n * ETH);
    expect(marketValue(10n * ETH, 0, false, 455)).toBe((10n * ETH * 9545n) / 10_000n);
  });

  it("inverts the price when the coin is currency1", () => {
    const t = 23_027; // 1.0001^23027 ~= 10
    const asC0 = marketValue(ETH, t, true, 0);
    const asC1 = marketValue(ETH, -t, false, 0);
    expect(Number(asC0) / 1e18).toBeCloseTo(10, 2);
    expect(Number(asC1) / 1e18).toBeCloseTo(10, 2);
  });
});
