import { describe, expect, it } from "vitest";

import { chainNowSecs, syncChainClock } from "./clock";

describe("chain clock", () => {
  it("follows the chain when the device clock is off, ignores small lag", () => {
    const local = Date.now();
    syncChainClock(Math.floor(local / 1000) - 3600, local); // device an hour ahead
    expect(chainNowSecs() - Math.floor(Date.now() / 1000)).toBeCloseTo(-3600, -1);
    syncChainClock(Math.floor(local / 1000) + 12, local); // a few seconds of block lag
    expect(chainNowSecs()).toBeCloseTo(Math.floor(Date.now() / 1000), -1);
  });
});
