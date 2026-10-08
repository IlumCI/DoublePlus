import { describe, expect, it } from "vitest";

import { marketState, poolPriceUsd, premium } from "./stockPremium";

describe("stock premiums", () => {
  it("knows when the market is open, in extended hours, or shut for the weekend", () => {
    // 2026-10-08 is a Thursday; New York is UTC-4 in October.
    expect(marketState(new Date("2026-10-08T15:00:00Z"))).toBe("regular"); // 11:00 ET
    expect(marketState(new Date("2026-10-08T02:00:00Z"))).toBe("extended"); // Wed 22:00 ET
    expect(marketState(new Date("2026-10-10T15:00:00Z"))).toBe("closed"); // Saturday
    expect(marketState(new Date("2026-10-09T23:59:00Z"))).toBe("extended"); // Fri 19:59 ET, the 24/5 session's last minute
    expect(marketState(new Date("2026-10-10T00:30:00Z"))).toBe("closed"); // Fri 20:30 ET
    expect(marketState(new Date("2026-10-12T00:30:00Z"))).toBe("extended"); // Sun 20:30 ET, the week reopens
  });

  it("reads a V3 price either way round, across decimals", () => {
    // 1 stock (18 dp) = 236 USDG (6 dp), stock as token0: raw = 236e6 / 1e18.
    const raw = (236e6 / 1e18);
    const sqrt = BigInt(Math.round(Math.sqrt(raw) * 2 ** 96));
    expect(poolPriceUsd(sqrt, true, 18, 6, 1)).toBeCloseTo(236, 3);
    // Same pool with the stock as token1: raw = 1e18 / 236e6.
    const sqrt1 = BigInt(Math.round(Math.sqrt(1e18 / 236e6) * 2 ** 96));
    expect(poolPriceUsd(sqrt1, false, 18, 6, 1)).toBeCloseTo(236, 3);
    // WETH-quoted: 0.1 ETH per share at $2,500 ETH.
    const sqrtW = BigInt(Math.round(Math.sqrt(0.1) * 2 ** 96));
    expect(poolPriceUsd(sqrtW, true, 18, 18, 2500)).toBeCloseTo(250, 3);
    expect(premium(61, 30.5)).toBeCloseTo(1, 9);
  });
});
