import { describe, expect, it } from "vitest";

import type { PoolTrade } from "./client";
import { isProtocolSwap, marketStats } from "./stats";

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
