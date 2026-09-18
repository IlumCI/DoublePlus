import { describe, expect, it } from "vitest";

import type { PoolTrade } from "./client";
import { isProtocolSwap, marketStats } from "./stats";
import { fmtUsdPrice, pickInterval } from "./format";

const NOW = 1_700_000_000;

/** `priceWei` is pair-wei per whole coin; `pairAmount` is the ETH leg. */
function trade(agoSecs: number, isBuy: boolean, priceEth: number, ethAmt: number): PoolTrade {
  return {
    isBuy,
    coinAmount: 10n ** 18n,
    pairAmount: BigInt(Math.round(ethAmt * 1e18)),
    priceWei: BigInt(Math.round(priceEth * 1e18)),
    blockNumber: 1,
    ts: NOW - agoSecs,
    txHash: `0x${agoSecs.toString(16).padStart(64, "0")}`,
  };
}

describe("marketStats", () => {
  it("sums only the last 24h and splits buy from sell volume", () => {
    const st = marketStats([
      trade(90_000, true, 1, 5), // older than 24h: excluded
      trade(3_600, true, 1, 2),
      trade(1_800, false, 1, 1),
      trade(600, true, 1, 3),
    ], NOW);
    expect(st.vol24Wei).toBe(6n * 10n ** 18n);
    expect(st.buyVol24Wei).toBe(5n * 10n ** 18n);
    expect(st.sellVol24Wei).toBe(1n * 10n ** 18n);
    expect(st.buys24).toBe(2);
    expect(st.sells24).toBe(1);
  });

  it("measures each window against the last price at or before it opened", () => {
    const st = marketStats([
      trade(86_400, true, 1, 1),   // 24h ago: 1.0
      trade(14_400, true, 2, 1),   // 4h ago:  2.0
      trade(3_600, true, 4, 1),    // 1h ago:  4.0
      trade(300, true, 5, 1),      // 5m ago:  5.0
      trade(0, true, 10, 1),       // now:     10.0
    ], NOW);
    expect(st.priceWei).toBe(10n * 10n ** 18n);
    expect(st.change.h24).toBeCloseTo(900, 6);  // 1 -> 10
    expect(st.change.h4).toBeCloseTo(400, 6);   // 2 -> 10
    expect(st.change.h1).toBeCloseTo(150, 6);   // 4 -> 10
    expect(st.change.m5).toBeCloseTo(100, 6);   // 5 -> 10
  });

  it("reports a fall as negative and a flat market as zero", () => {
    const down = marketStats([trade(7_200, true, 4, 1), trade(0, false, 1, 1)], NOW);
    expect(down.change.h4).toBeCloseTo(-75, 6);
    const flat = marketStats([trade(7_200, true, 3, 1), trade(0, true, 3, 1)], NOW);
    expect(flat.change.h4).toBe(0);
  });

  it("falls back to the first trade for a window older than the pool", () => {
    // Two minutes of history: every window's reference is the opening trade.
    const young = marketStats([trade(60, true, 2, 1), trade(0, true, 3, 1)], NOW);
    expect(young.change.h24).toBeCloseTo(50, 6);
    expect(young.change.m5).toBeCloseTo(50, 6);
  });

  it("has no change to report from a single trade, or none", () => {
    const one = marketStats([trade(0, true, 3, 1)], NOW);
    expect(one.priceWei).toBe(3n * 10n ** 18n);
    expect(one.change.h24).toBeNull();
    expect(one.change.m5).toBeNull();

    const empty = marketStats([], NOW);
    expect(empty.priceWei).toBe(0n);
    expect(empty.vol24Wei).toBe(0n);
    expect(empty.buys24).toBe(0);
    expect(empty.change.h24).toBeNull();
  });
});

describe("isProtocolSwap", () => {
  // Real addresses from the testnet stack the behaviour was measured on.
  const HOOK = "0x3485280D944E18b1D64A76Fe42200F12967d2044";
  const FACTORY = "0x6AbCaAD1F8b5272E8006bca288C1Bcc77248E62D";
  const ROUTER = "0x2b43391216071b9041357f297FDBA6a856ab14B4";
  const ZERO = "0x0000000000000000000000000000000000000000";

  it("identifies the fee hook's own conversions", () => {
    expect(isProtocolSwap(HOOK, { hook: HOOK, factory: FACTORY })).toBe(true);
    expect(isProtocolSwap(FACTORY, { hook: HOOK, factory: FACTORY })).toBe(true);
  });

  it("leaves real trades alone", () => {
    expect(isProtocolSwap(ROUTER, { hook: HOOK, factory: FACTORY })).toBe(false);
    expect(isProtocolSwap("0xB663e6DE5Dd76bf30BE308f847Da5b1B276Dc700", { hook: HOOK, factory: FACTORY })).toBe(false);
  });

  it("compares case-insensitively, since log addresses are not checksummed", () => {
    expect(isProtocolSwap(HOOK.toLowerCase(), { hook: HOOK, factory: FACTORY })).toBe(true);
    expect(isProtocolSwap(HOOK.toUpperCase().replace("0X", "0x"), { hook: HOOK, factory: FACTORY })).toBe(true);
  });

  it("never filters on an unconfigured address", () => {
    // A build with no hook configured must not drop every swap whose sender
    // fails to match, nor match the zero address by accident.
    expect(isProtocolSwap(ZERO, { hook: ZERO, factory: ZERO })).toBe(false);
    expect(isProtocolSwap(ROUTER, {})).toBe(false);
    expect(isProtocolSwap(ZERO, {})).toBe(false);
  });
});

describe("fmtUsdPrice", () => {
  it("keeps ordinary prices ordinary", () => {
    expect(fmtUsdPrice(1234.5)).toBe("$1,234.5");
    expect(fmtUsdPrice(0.5)).toBe("$0.5000");
    expect(fmtUsdPrice(0.0123)).toBe("$0.0123");
  });

  it("distinguishes micro-cap prices that fixed 4dp collapses to $0.0000", () => {
    // The whole point: these three differ by 10x and must not render alike.
    expect(fmtUsdPrice(0.000318)).toBe("$0.0₃3180");
    expect(fmtUsdPrice(0.0000318)).toBe("$0.0₄3180");
    expect(fmtUsdPrice(0.00000318)).toBe("$0.0₅3180");
  });

  it("carries a rounding overflow into one fewer leading zero", () => {
    // 9.9999e-5 rounds to 1.000e-4, which is three zeros and 1000, not four
    // zeros and a five-digit mantissa.
    expect(fmtUsdPrice(9.9999e-5)).toBe("$0.0₃1000");
  });

  it("handles zero and nonsense without emitting NaN", () => {
    expect(fmtUsdPrice(0)).toBe("$0");
    expect(fmtUsdPrice(-1)).toBe("$0");
    expect(fmtUsdPrice(Number.NaN)).toBe("$0");
  });
});

describe("marketStats.ageSecs", () => {
  it("reports how long the pool has traded, so young windows can be marked", () => {
    const st = marketStats([trade(900, true, 1, 1), trade(60, false, 2, 1)], NOW);
    expect(st.ageSecs).toBe(900);
  });

  it("is zero when nothing has traded", () => {
    expect(marketStats([], NOW).ageSecs).toBe(0);
  });
});

describe("pickInterval", () => {
  const IVS = [60, 300, 900, 3_600, 14_400, 86_400];

  it("prefers resolution while the bar count stays readable", () => {
    expect(pickInterval(10 * 60, IVS)).toBe(60);       // 10 min -> 10 bars
    expect(pickInterval(3 * 3_600, IVS)).toBe(60);     // 3 h    -> 180 bars
  });

  it("steps up as the history outgrows the finer intervals", () => {
    expect(pickInterval(86_400, IVS)).toBe(300);       // a day   -> 288 bars at 5m
    expect(pickInterval(7 * 86_400, IVS)).toBe(3_600); // a week  -> 168 bars at 1h
    expect(pickInterval(30 * 86_400, IVS)).toBe(14_400); // a month -> 180 bars at 4h
  });

  it("uses the coarsest interval when even that overflows", () => {
    // Two years is 730 daily bars; nothing fits, so take the coarsest rather
    // than emit a million.
    expect(pickInterval(730 * 86_400, IVS)).toBe(86_400);
  });

  it("returns the finest interval for a pool too young to fill one bar", () => {
    expect(pickInterval(60, IVS)).toBe(60);
    expect(pickInterval(0, IVS)).toBe(60);
    expect(pickInterval(-5, IVS)).toBe(60);
  });

  it("does not depend on the caller passing intervals in order", () => {
    expect(pickInterval(10 * 60, [3_600, 60, 300])).toBe(60);
  });
});
