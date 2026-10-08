import { describe, expect, it } from "vitest";

import { dailyDividendsWei, tierIndex, tierRows, TIERS } from "./tiers";

const E = 10n ** 18n;

describe("tiers", () => {
  it("places a balance on the same step as the token's ladder", () => {
    const floor = 1_000n * E;
    expect(tierIndex(999n * E, floor)).toBe(-1);
    expect(tierIndex(floor, floor)).toBe(0);
    expect(tierIndex(2_999n * E, floor)).toBe(0);
    expect(tierIndex(3_000n * E, floor)).toBe(1);
    expect(tierIndex(299_999n * E, floor)).toBe(4);
    expect(tierIndex(1_000_000n * E, floor)).toBe(6);
    expect(tierIndex(10n ** 12n * E, floor)).toBe(6);
    expect(tierIndex(5n, 0n)).toBe(-1);
    expect(TIERS.map((t) => Number(t.bps) / 10_000)).toEqual([1, 1.5, 2, 3, 5, 7.5, 10]);
  });

  it("estimates the day's dividends from each side's volume and tax", () => {
    // 10 ETH bought at 4%, 5 ETH sold at 2%, half of it to holders.
    const d = dailyDividendsWei(10n * E, 5n * E, { buyTaxBps: 400, sellTaxBps: 200, dividendBps: 5_000 });
    expect(d).toBe((25n * E) / 100n); // (0.4 + 0.1) / 2
  });

  it("gives each step its share once its own weight joins the pool", () => {
    const floor = 1_000n * E;
    const rows = tierRows(floor, 9_000n * E, 10n * E);
    expect(rows[0].mult).toBe(10);
    expect(rows[6].mult).toBe(1);
    // 1x: 1k weight beside 9k -> a tenth of the day.
    expect(rows[6].dailyWei).toBe(E);
    // Every step up earns more, and no step can earn the whole day.
    for (let i = 0; i < 6; i++) expect(rows[i].dailyWei).toBeGreaterThan(rows[i + 1].dailyWei);
    expect(rows[0].dailyWei).toBeLessThan(10n * E);
    expect(tierRows(floor, 0n, 0n).every((r) => r.dailyWei === 0n)).toBe(true);
  });
});
