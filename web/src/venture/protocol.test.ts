import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

import * as P from "./protocol";
import { TIERS } from "./tiers";

// Every contract constant the UI copies, checked against the Solidity source,
// so a contract change can't leave the site quietly showing the old rules.
const src = (f: string) => fs.readFileSync(path.join(__dirname, "../../../contracts/contracts/v4", f), "utf8");
const constant = (s: string, name: string): string => {
  const m = s.match(new RegExp(`constant ${name}\\s*=\\s*([^;]+);`));
  if (!m) throw new Error(`${name} not found`);
  return m[1].replace(/_/g, "").trim();
};
const num = (expr: string): number => {
  const units: Record<string, number> = { ether: 1, days: 86_400, hours: 3_600 };
  const [n, unit] = expr.split(/\s+/);
  const v = Number(n.replace(/\*\s*1e8$/, ""));
  return unit ? v * (unit === "ether" ? 1 : units[unit]) : v;
};

describe("protocol constants match the contracts", () => {
  const factory = src("venture/VentureFactory.sol");
  const hook = src("venture/VentureFeeHook.sol");

  it("supply and curve", () => {
    expect(num(constant(factory, "TOTAL_SUPPLY"))).toBe(P.TOTAL_SUPPLY);
    expect(num(constant(factory, "CURVE_SUPPLY_WHOLE"))).toBe(P.CURVE_SUPPLY);
    expect(constant(factory, "START_MCAP_USD_8")).toBe(`${P.START_FDV_USD} * 1e8`);
  });

  it("raise rules", () => {
    expect(num(constant(factory, "MAX_RAISE_SECS"))).toBe(P.MAX_RAISE_DAYS * 86_400);
    expect(num(constant(factory, "LAUNCH_WINDOW_SECS"))).toBe(P.LAUNCH_WINDOW_SECS);
  });

  it("referral discount", () => {
    expect(num(constant(hook, "REFEREE_DISCOUNT_BPS"))).toBe(P.REFEREE_DISCOUNT_BPS);
  });

  it("holder tier ladder", () => {
    const body = src("QuiverToken.sol").match(/function tierMultiplierBps[\s\S]*?\n {4}}/)![0];
    const steps = [...body.matchAll(/m >= (\d+)\) return ([\d_]+)/g)].map(([, m, b]) => [BigInt(m), BigInt(b.replace(/_/g, ""))]);
    const base = BigInt(body.match(/return ([\d_]+);\s*\n\s*}$/)![1].replace(/_/g, ""));
    const ladder = [[1n, base], ...steps.reverse()];
    expect(TIERS.map((t) => [t.min, t.bps])).toEqual(ladder);
  });
});
