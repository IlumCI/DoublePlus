import { describe, expect, it } from "vitest";

import { authMessage, cleanBody, issueSession, readSession, SESSION_SECS } from "../src/lib";

const A = "0x1111111111111111111111111111111111111111";

describe("sessions", () => {
  it("round-trips and binds to the address, lowercased", async () => {
    const { token } = await issueSession("s3cret", A.toUpperCase().replace("0X", "0x"), 1000);
    expect(await readSession("s3cret", token, 1001)).toBe(A);
  });
  it("rejects a token under another secret, a tampered address, or past expiry", async () => {
    const { token } = await issueSession("s3cret", A, 1000);
    expect(await readSession("other", token, 1001)).toBeNull();
    expect(await readSession("s3cret", token.replace("0x1111", "0x2222"), 1001)).toBeNull();
    expect(await readSession("s3cret", token, 1000 + SESSION_SECS + 1)).toBeNull();
    expect(await readSession("s3cret", "garbage", 1001)).toBeNull();
  });
});

describe("cleanBody", () => {
  it("trims, strips control and bidi characters, collapses blank lines", () => {
    const r = cleanBody("  gm‮\u0007\n\n\n\nwagmi  ");
    expect(r).toEqual({ ok: true, body: "gm\n\nwagmi" });
  });
  it("refuses empty, overlong and link-spam comments", () => {
    expect(cleanBody("   ").ok).toBe(false);
    expect(cleanBody(42).ok).toBe(false);
    expect(cleanBody("x".repeat(281)).ok).toBe(false);
    expect(cleanBody("x".repeat(280)).ok).toBe(true);
    expect(cleanBody("https://a.co https://b.co https://c.co").ok).toBe(false);
    expect(cleanBody("https://a.co and https://b.co").ok).toBe(true);
  });
  it("counts characters, not UTF-16 units", () => {
    expect(cleanBody("🚀".repeat(280)).ok).toBe(true);
  });
});

describe("authMessage", () => {
  it("is stable and lowercases the address", () => {
    expect(authMessage(A.replace("0x1", "0xA"), "2026-10-03T00:00:00.000Z")).toContain("Sign in as 0xa111");
  });
});
