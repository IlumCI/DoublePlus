import { describe, expect, it } from "vitest";

import { consoleAuthMessage, ethFromWei, newNonce, weiFromEth } from "./console";

/** The exact text a wallet is asked to sign.
 *
 *  Written out in full rather than built from the function, because the worker
 *  verifies this string and asserts the same literal in api/test/lucre.test.ts.
 *  If either side is edited alone, one of the two tests fails instead of every
 *  sign-in failing in production. */
const EXPECTED = `doubleplus.fun wants you to sign in to the launch console.

Wallet: 0x1111111111111111111111111111111111111111
Issued at: 2026-01-01T00:00:00.000Z
Nonce: a1b2c3d4e5f60718

Signing in lets this wallet design and launch coins on this launchpad,
which spends the operator's ETH on opening buys.
This signature cannot move funds by itself.`;

describe("the message a wallet signs", () => {
  it("is exactly what the worker verifies", () => {
    expect(
      consoleAuthMessage("0x1111111111111111111111111111111111111111", "2026-01-01T00:00:00.000Z", "a1b2c3d4e5f60718"),
    ).toBe(EXPECTED);
  });

  it("lowercases the wallet, as the worker does before comparing", () => {
    expect(consoleAuthMessage("0xABCDEF1111111111111111111111111111111111", "t", "n")).toContain(
      "Wallet: 0xabcdef1111111111111111111111111111111111",
    );
  });

  it("gives a fresh nonce each time, so a signature cannot be replayed", () => {
    const seen = new Set(Array.from({ length: 50 }, newNonce));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(n).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("the opening buy a form collects", () => {
  it("reads an ETH amount as exact wei", () => {
    expect(weiFromEth("1")).toEqual({ ok: true, wei: "1000000000000000000" });
    expect(weiFromEth("0.005")).toEqual({ ok: true, wei: "5000000000000000" });
    expect(weiFromEth("0.000000000000000001")).toEqual({ ok: true, wei: "1" });
    expect(weiFromEth("  ")).toEqual({ ok: true, wei: "0" });
  });

  it("does not round a figure it cannot represent exactly", () => {
    // Through Number this would be 1.0000000000000002e18.
    expect(weiFromEth("1.000000000000000001")).toEqual({ ok: true, wei: "1000000000000000001" });
  });

  it("refuses anything that is not a plain amount", () => {
    for (const bad of ["1e18", "-1", "0.1234567890123456789", "1,5", "abc", "0x10"]) {
      expect(weiFromEth(bad).ok, bad).toBe(false);
    }
  });

  it("shows small amounts without pretending they are zero", () => {
    expect(ethFromWei("0")).toBe("0");
    expect(ethFromWei("1")).toBe("1.00e-18");
    expect(ethFromWei("5000000000000000")).toBe("0.005");
  });
});
