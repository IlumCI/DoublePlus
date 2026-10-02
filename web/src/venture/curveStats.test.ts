import { describe, expect, it } from "vitest";
import type { Address } from "viem";

import { computeStats, type LaunchLog, type TradeLog } from "./curveStats";

const T = "0x00000000000000000000000000000000000000aa" as Address;
const DEV = "0x00000000000000000000000000000000000000d0" as Address;
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Address;
const E = 10n ** 18n;

const launch: LaunchLog[] = [{ token: T, creator: DEV, block: 100n }];
const buy = (who: Address, tokens: bigint, block: bigint, eth = E / 100n): TradeLog => ({ token: T, who, tokens, eth, block });

describe("computeStats", () => {
  it("counts unique non-creator buyers and the first minute", () => {
    // 1 block per second: the first minute is blocks 100..160.
    const s = computeStats(launch, [buy(a(1), 10n, 101n), buy(a(1), 5n, 120n), buy(a(2), 5n, 159n), buy(a(3), 5n, 400n), buy(DEV, 5n, 105n)], [], 1)
      .get(T.toLowerCase())!;
    expect(s.buyers).toBe(3);
    expect(s.firstMinBuyers).toBe(2);
    expect(s.firstMinEth).toBe((E / 100n) * 3n); // the dev's own buy is not momentum
  });

  it("flags a non-creator buy in the launch block as sniped, not the creator's own", () => {
    expect(computeStats(launch, [buy(DEV, 10n, 100n)], [], 1).get(T.toLowerCase())!.sniped).toBe(false);
    expect(computeStats(launch, [buy(a(9), 10n, 100n)], [], 1).get(T.toLowerCase())!.sniped).toBe(true);
  });

  it("measures dev share and top-10 concentration on net curve holdings", () => {
    const buys = [buy(DEV, 50n, 101n), ...Array.from({ length: 12 }, (_, i) => buy(a(i + 1), 10n, 200n))];
    const s = computeStats(launch, buys, [], 1).get(T.toLowerCase())!;
    // 50 dev + 120 others = 170. Top ten: dev 50 + nine at 10 = 140.
    expect(s.devPct).toBeCloseTo((50 / 170) * 100, 1);
    expect(s.top10Pct).toBeCloseTo((140 / 170) * 100, 1);
  });

  it("nets sells against buys", () => {
    const s = computeStats(launch, [buy(DEV, 50n, 101n), buy(a(1), 50n, 101n)], [{ token: T, who: DEV, tokens: 50n, eth: 0n, block: 300n }], 1)
      .get(T.toLowerCase())!;
    expect(s.devPct).toBe(0);
    expect(s.top10Pct).toBe(100);
  });
});
