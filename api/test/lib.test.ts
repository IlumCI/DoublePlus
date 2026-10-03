import { describe, expect, it } from "vitest";

import { authMessage, carriesDecoy, cleanBody, DECOY_KEY, isTrap, issueSession, readSession, SESSION_SECS } from "../src/lib";

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
  it("names the domain, lowercases the address and carries the nonce", () => {
    const m = authMessage(A.replace("0x1", "0xA"), "2026-10-03T00:00:00.000Z", "00ff00ff00ff00ff");
    expect(m.startsWith("doubleplus.fun wants you to sign in")).toBe(true);
    expect(m).toContain("Wallet: 0xa111");
    expect(m).toContain("Nonce: 00ff00ff00ff00ff");
  });
});

describe("isTrap", () => {
  it("catches what scanners probe", () => {
    for (const p of ["/admin", "/admin/login", "/internal/config", "/.env", "/.git/config", "/wp-login.php",
      "/phpmyadmin/", "/backup.sql", "/config.yml", "/api/v1/export", "/actuator/health", "/graphql", "/server-status",
      "/index.php", "/.aws/credentials", "/secrets.json", "/debug"]) {
      expect(isTrap(p), p).toBe(true);
    }
  });
  it("leaves the real API alone", () => {
    for (const p of ["/auth", "/comments", "/health", "/robots.txt", "/", "/commentsadmin"]) expect(isTrap(p), p).toBe(false);
  });
});

describe("carriesDecoy", () => {
  it("spots the decoy key in a header or the query string", () => {
    const u = new URL("https://api.example/comments");
    expect(carriesDecoy(new Headers({ Authorization: `Bearer ${DECOY_KEY}` }), u)).toBe(true);
    expect(carriesDecoy(new Headers({ apikey: DECOY_KEY }), u)).toBe(true);
    expect(carriesDecoy(new Headers(), new URL(`https://api.example/x?key=${DECOY_KEY}`))).toBe(true);
    expect(carriesDecoy(new Headers({ Authorization: "Bearer 0xabc.123.mac" }), u)).toBe(false);
  });
});
