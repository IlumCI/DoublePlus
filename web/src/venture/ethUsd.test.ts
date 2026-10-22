import { describe, expect, it } from "vitest";
import { medianPrice, sanePrice } from "./ethUsd";

describe("medianPrice", () => {
  it("is 0 when no source answered", () => {
    expect(medianPrice([])).toBe(0);
    expect(medianPrice([0, 0, 0])).toBe(0);
  });
  it("uses the one source that answered", () => {
    expect(medianPrice([0, 2394.81, 0])).toBe(2394.81);
  });
  it("averages two sources", () => {
    expect(medianPrice([2394, 2400])).toBe(2397);
  });
  it("ignores one stale or broken source out of three", () => {
    expect(medianPrice([2394.81, 1855, 2400.06])).toBe(2394.81);
    expect(medianPrice([2394.81, 99999, 2400.06])).toBe(2400.06);
  });
});

describe("sanePrice", () => {
  it("parses API strings", () => {
    expect(sanePrice("2394.81")).toBe(2394.81);
  });
  it("rejects missing, non-numeric and absurd readings", () => {
    expect(sanePrice(undefined)).toBe(0);
    expect(sanePrice("n/a")).toBe(0);
    expect(sanePrice("1865000")).toBe(0);
    expect(sanePrice("3")).toBe(0);
  });
});
