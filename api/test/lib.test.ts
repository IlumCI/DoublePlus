import { verifyMessage } from "viem";
import { describe, expect, it } from "vitest";

import { authMessage, carriesDecoy, sigKey, fromBrowser, ipKey, cleanBody, DECOY_KEY, isTrap, issueSession, MAX_REQUEST_BYTES, readJson, readSession, SESSION_SECS } from "../src/lib";

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
  it("spots the decoy key in a header, never from the query string", () => {
    expect(carriesDecoy(new Headers({ Authorization: `Bearer ${DECOY_KEY}` }))).toBe(true);
    expect(carriesDecoy(new Headers({ apikey: DECOY_KEY }))).toBe(true);
    expect(carriesDecoy(new Headers())).toBe(false);
    expect(carriesDecoy(new Headers({ Authorization: "Bearer 0xabc.123.mac" }))).toBe(false);
  });
});

describe("sigKey", () => {
  it("gives every encoding of one signature the same key", async () => {
    const { privateKeyToAccount, generatePrivateKey } = await import("viem/accounts");
    const acct = privateKeyToAccount(generatePrivateKey());
    const sig = await acct.signMessage({ message: "hi" });
    const r = sig.slice(2, 66), s = BigInt("0x" + sig.slice(66, 130)), v = parseInt(sig.slice(130), 16);
    const N = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
    const hi = (N - s).toString(16).padStart(64, "0");
    const flip = (x: number) => (x === 27 ? 28 : 27);
    const variants = [
      `0x${r}${sig.slice(66, 130)}${(v - 27).toString(16).padStart(2, "0")}`,
      `0x${r}${hi}${flip(v).toString(16)}`,
      `0x${r}${hi}${(flip(v) - 27).toString(16).padStart(2, "0")}`,
    ];
    for (const x of variants) {
      expect(await verifyMessage({ address: acct.address, message: "hi", signature: x as `0x${string}` })).toBe(true);
      expect(sigKey(x)).toBe(sigKey(sig));
    }
  });
});

describe("ipKey", () => {
  it("keeps v4 and folds v6 to its /64", () => {
    expect(ipKey("203.0.113.9")).toBe("203.0.113.9");
    expect(ipKey("2001:db8:a:b:1:2:3:4")).toBe(ipKey("2001:0db8:000a:000b:ffff::1"));
    expect(ipKey("2001:db8::1")).toBe("2001:db8:0:0::/64");
    expect(ipKey("2001:db8:a:b:1:2:3:4")).not.toBe(ipKey("2001:db8:a:c::1"));
  });
});

describe("fromBrowser", () => {
  it("tells a browser request from a scanner", () => {
    expect(fromBrowser(new Headers({ "Sec-Fetch-Mode": "no-cors", "Sec-Fetch-Dest": "image" }))).toBe(true);
    expect(fromBrowser(new Headers({ "User-Agent": "curl/8" }))).toBe(false);
  });
});

describe("readJson", () => {
  const post = (body: BodyInit, headers: Record<string, string> = {}) =>
    new Request("https://api.test/comments", { method: "POST", body, headers, duplex: "half" } as RequestInit);
  const chunked = (parts: string[]) => new ReadableStream<Uint8Array>({
    start(c) { for (const p of parts) c.enqueue(new TextEncoder().encode(p)); c.close(); },
  });

  it("parses a small object", async () => {
    expect(await readJson(post('{"a":1}'))).toEqual({ a: 1 });
  });
  it("refuses a declared oversize body without reading it", async () => {
    expect(await readJson(post("{}", { "Content-Length": String(MAX_REQUEST_BYTES + 1) }))).toBe("too_big");
  });
  it("cuts off a chunked body that never declared its length", async () => {
    const chunk = "x".repeat(1024);
    expect(await readJson(post(chunked(['{"a":"', chunk, chunk, chunk, chunk, chunk, '"}'])))).toBe("too_big");
  });
  it("rejects arrays, primitives, broken JSON and invalid UTF-8", async () => {
    expect(await readJson(post("[1,2]"))).toBeNull();
    expect(await readJson(post("42"))).toBeNull();
    expect(await readJson(post("{nope"))).toBeNull();
    expect(await readJson(post(new Uint8Array([0x7b, 0xff, 0x7d])))).toBeNull();
  });
});
