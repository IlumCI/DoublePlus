import { describe, expect, it } from "vitest";

import { alertsFor } from "./alerts";
import type { Venture } from "./client";

const ETH = 10n ** 18n;
const coin = (phase: Venture["phase"], raisedEth: number): Venture =>
  ({ address: "0xabc", symbol: "TEST", phase, raisedWei: BigInt(raisedEth * 100) * ETH / 100n, targetRaiseWei: 4n * ETH }) as unknown as Venture;

describe("alertsFor", () => {
  it("stays quiet on first sight, and when nothing crossed a line", () => {
    expect(alertsFor(undefined, coin("graduated", 4))).toEqual([]);
    expect(alertsFor({ phase: "raising", funded: 40 }, coin("raising", 2))).toEqual([]);
  });

  it("fires once when a raise crosses 90%, not on every poll after", () => {
    expect(alertsFor({ phase: "raising", funded: 80 }, coin("raising", 3.7))[0].title).toMatch(/^\$TEST is 9\d% full$/);
    expect(alertsFor({ phase: "raising", funded: 92 }, coin("raising", 3.8))).toEqual([]);
  });

  it("announces graduation and failure, and only the bigger news when both apply", () => {
    const g = alertsFor({ phase: "raising", funded: 80 }, coin("graduated", 4));
    expect(g).toHaveLength(1);
    expect(g[0].title).toMatch(/graduated/);
    expect(alertsFor({ phase: "raising", funded: 50 }, coin("failed", 2))[0].body).toMatch(/Refunds/);
  });
});
