import { describe, expect, it } from "vitest";
import { privateKeyToAccount } from "viem/accounts";

import { consoleAuthMessage, issueSession, readSession } from "../src/lib";
import { allowsLive, consoleAuth, isOperator, matchRoute, narrowRunBody, operators, proxy, type LucreEnv } from "../src/lucre";

const SECRET = "s".repeat(32);
const account = privateKeyToAccount(`0x${"7".repeat(64)}`);
const OP = account.address;
const OTHER = "0x1111111111111111111111111111111111111111";

const env = (over: Partial<LucreEnv> = {}): LucreEnv => ({
  SESSION_SECRET: SECRET,
  LUCRE_URL: "https://lucre.invalid",
  LUCRE_TOKEN: "t".repeat(40),
  LUCRE_OPERATORS: OP,
  ...over,
});

const NOW = 1_800_000_000;

async function consoleToken(address = OP, at = NOW): Promise<string> {
  return (await issueSession(SECRET, address, at, "console")).token;
}

function req(method: string, body?: unknown, token?: string): Request {
  return new Request("https://api.invalid/lucre/runs", {
    method,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: {
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
  });
}

describe("a console session is not a chat session", () => {
  it("will not let a coin-chat sign-in open the console", async () => {
    const chat = (await issueSession(SECRET, OP, NOW)).token;
    expect(await readSession(SECRET, chat, NOW + 1)).toBe(OP.toLowerCase());
    // Consenting to talk on a coin page is not consenting to spend ETH.
    expect(await readSession(SECRET, chat, NOW + 1, "console")).toBeNull();
  });

  it("will not let a console session post comments either", async () => {
    const token = await consoleToken();
    expect(await readSession(SECRET, token, NOW + 1, "console")).toBe(OP.toLowerCase());
    expect(await readSession(SECRET, token, NOW + 1)).toBeNull();
  });

  it("says in the text what signing in authorises", () => {
    const m = consoleAuthMessage(OP, "2026-01-01T00:00:00Z", "abcdef0123456789");
    expect(m).toMatch(/launch console/);
    expect(m).toMatch(/spends the operator's ETH/);
    expect(m).toMatch(/cannot move funds/);
  });

  it("is byte-for-byte what the browser signs", () => {
    // The same literal is asserted in web/src/venture/console.test.ts. Editing
    // either side alone fails one of the two tests, rather than failing every
    // sign-in once it ships.
    expect(
      consoleAuthMessage("0x1111111111111111111111111111111111111111", "2026-01-01T00:00:00.000Z", "a1b2c3d4e5f60718"),
    ).toBe(
      `doubleplus.fun wants you to sign in to the launch console.

Wallet: 0x1111111111111111111111111111111111111111
Issued at: 2026-01-01T00:00:00.000Z
Nonce: a1b2c3d4e5f60718

Signing in lets this wallet design and launch coins on this launchpad,
which spends the operator's ETH on opening buys.
This signature cannot move funds by itself.`,
    );
  });
});

describe("who counts as an operator", () => {
  it("reads a list, ignores case and drops anything that is not an address", () => {
    const e = env({ LUCRE_OPERATORS: ` ${OP.toUpperCase()} , not-an-address, ${OTHER} ` });
    expect(operators(e)).toEqual([OP.toLowerCase(), OTHER]);
    expect(isOperator(e, OP)).toBe(true);
    expect(isOperator(e, OP.toLowerCase())).toBe(true);
    expect(isOperator(e, "0x2222222222222222222222222222222222222222")).toBe(false);
  });

  it("has nobody when the list is unset", () => {
    expect(operators(env({ LUCRE_OPERATORS: undefined }))).toEqual([]);
    expect(isOperator(env({ LUCRE_OPERATORS: undefined }), OP)).toBe(false);
  });
});

describe("what a browser may ask for", () => {
  it("keeps the design fields and drops everything else", () => {
    const r = narrowRunBody(
      {
        profile: "crypto",
        topic: "a thing",
        firstBuyWei: "1000",
        designOnly: true,
        tax: { buyTaxBps: 100 },
        // Fields the service owns, and a field that does not exist yet.
        rpcUrl: "http://evil",
        privateKey: "0xdead",
        tenant: "someone-else",
        somethingNew: 1,
      },
      env(),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(Object.keys(r.body).sort()).toEqual(["designOnly", "firstBuyWei", "profile", "tax", "topic"]);
  });

  it("refuses a live launch on a design-only deployment, rather than downgrading it", () => {
    const r = narrowRunBody({ live: true }, env());
    expect(r.ok).toBe(false);
    // Silently dry-running would send the caller looking for a coin that does
    // not exist.
    if (!r.ok) expect(r.error).toMatch(/design only/);
  });

  it("passes a live launch through when the deployment allows one", () => {
    expect(allowsLive(env())).toBe(false);
    expect(allowsLive(env({ LUCRE_ALLOW_LIVE: "1" }))).toBe(true);
    const r = narrowRunBody({ live: true }, env({ LUCRE_ALLOW_LIVE: "1" }));
    expect(r.ok && r.body.live).toBe(true);
  });

  it("omits live entirely when it was not asked for", () => {
    const r = narrowRunBody({ topic: "x" }, env({ LUCRE_ALLOW_LIVE: "1" }));
    expect(r.ok && "live" in r.body).toBe(false);
  });

  it("rejects a non-boolean live", () => {
    expect(narrowRunBody({ live: "yes" }, env({ LUCRE_ALLOW_LIVE: "1" })).ok).toBe(false);
  });
});

describe("which service routes the console exposes", () => {
  it("maps the ones it means to", () => {
    const id = "7eef252f-488c-450c-b517-2ce0d415d02a";
    expect(matchRoute("GET", "/ready")).toBe("/ready");
    expect(matchRoute("GET", "/budget")).toBe("/budget");
    expect(matchRoute("GET", `/runs/${id}`)).toBe(`/runs/${id}`);
    expect(matchRoute("POST", `/runs/${id}/cancel`)).toBe(`/runs/${id}/cancel`);
    expect(matchRoute("POST", "/loop/start")).toBe("/loop/start");
  });

  it("refuses anything else, rather than passing it along to find out", () => {
    expect(matchRoute("POST", "/ready")).toBeNull();
    expect(matchRoute("GET", "/endpoint-income")).toBeNull();
    expect(matchRoute("GET", "/runs/../income")).toBeNull();
    expect(matchRoute("GET", "/runs/short")).toBeNull();
    expect(matchRoute("DELETE", "/runs")).toBeNull();
  });
});

describe("proxying a console call", () => {
  const okFetch = (seen: { url?: string; init?: RequestInit }) =>
    (async (url: string, init: RequestInit) => {
      seen.url = url;
      seen.init = init;
      return new Response(JSON.stringify({ id: "x", state: "running" }), { status: 202 });
    }) as unknown as typeof fetch;

  it("is a closed door when it is not configured", async () => {
    for (const over of [{ LUCRE_URL: undefined }, { LUCRE_TOKEN: undefined }]) {
      const r = await proxy({ req: req("GET", undefined, await consoleToken()), env: env(over), path: "/ready", nowSecs: NOW });
      expect(r.status).toBe(503);
    }
  });

  it("needs a console session", async () => {
    expect((await proxy({ req: req("GET"), env: env(), path: "/ready", nowSecs: NOW })).status).toBe(401);
    const chat = (await issueSession(SECRET, OP, NOW)).token;
    expect((await proxy({ req: req("GET", undefined, chat), env: env(), path: "/ready", nowSecs: NOW })).status).toBe(401);
  });

  it("rechecks the allowlist on every call, not just at sign-in", async () => {
    const token = await consoleToken();
    // The wallet was removed after its session was issued.
    const r = await proxy({ req: req("GET", undefined, token), env: env({ LUCRE_OPERATORS: OTHER }), path: "/ready", nowSecs: NOW });
    expect(r.status).toBe(403);
    expect(r.as).toBeUndefined();
  });

  it("forwards with the service token, which the browser never sent", async () => {
    const seen: { url?: string; init?: RequestInit } = {};
    const r = await proxy({
      req: req("POST", { topic: "a thing", rpcUrl: "http://evil" }, await consoleToken()),
      env: env(),
      path: "/runs",
      nowSecs: NOW,
      fetchImpl: okFetch(seen),
    });
    expect(r.status).toBe(202);
    expect(r.as).toBe(OP.toLowerCase());
    expect(seen.url).toBe("https://lucre.invalid/runs");
    expect((seen.init!.headers as Record<string, string>).authorization).toBe(`Bearer ${"t".repeat(40)}`);
    // The field the server owns never left this worker.
    expect(JSON.parse(seen.init!.body as string)).toEqual({ topic: "a thing" });
  });

  it("refuses a route it does not expose", async () => {
    const r = await proxy({ req: req("GET", undefined, await consoleToken()), env: env(), path: "/endpoint-income", nowSecs: NOW });
    expect(r.status).toBe(404);
    expect(r.as).toBe(OP.toLowerCase());
  });

  it("does not hand a browser whatever a broken hop returned", async () => {
    const html = (async () => new Response("<html>502 Bad Gateway</html>", { status: 502 })) as unknown as typeof fetch;
    const r = await proxy({ req: req("GET", undefined, await consoleToken()), env: env(), path: "/ready", nowSecs: NOW, fetchImpl: html });
    expect(r.status).toBe(502);
    expect(r.body).toEqual({ error: "the launch service answered with something other than JSON" });
  });

  it("says so when the service is unreachable", async () => {
    const dead = (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch;
    const r = await proxy({ req: req("GET", undefined, await consoleToken()), env: env(), path: "/ready", nowSecs: NOW, fetchImpl: dead });
    expect(r.status).toBe(502);
    expect(String((r.body as { error: string }).error)).toMatch(/ECONNREFUSED/);
  });

  it("passes the service's own refusal through unchanged", async () => {
    const over = (async () =>
      new Response(JSON.stringify({ error: "this grant allows 2 launches and has used 2; 1 more would exceed it" }), {
        status: 402,
      })) as unknown as typeof fetch;
    const r = await proxy({
      req: req("POST", { live: true }, await consoleToken()),
      env: env({ LUCRE_ALLOW_LIVE: "1" }),
      path: "/runs",
      nowSecs: NOW,
      fetchImpl: over,
    });
    // The budget refusal is the service's to make, and the operator should read
    // it as written.
    expect(r.status).toBe(402);
    expect(r.body).toMatchObject({ error: expect.stringContaining("would exceed it") });
  });
});

describe("signing in to the console", () => {
  const never = async () => false;

  async function signIn(address: string, issuedAt: string, over: Partial<LucreEnv> = {}, seen = never) {
    const nonce = "a1b2c3d4e5f60718";
    const signature = await account.signMessage({ message: consoleAuthMessage(address, issuedAt, nonce) });
    const r = new Request("https://api.invalid/lucre/auth", {
      method: "POST",
      body: JSON.stringify({ address, issuedAt, nonce, signature }),
      headers: { "content-type": "application/json" },
    });
    return consoleAuth(r, env(over), NOW, seen);
  }

  const issuedNow = new Date(NOW * 1000).toISOString();

  it("issues a console session to an operator who proves the wallet", async () => {
    const r = await signIn(OP, issuedNow);
    expect(r.status).toBe(200);
    const token = (r.body as { token: string }).token;
    expect(await readSession(SECRET, token, NOW + 1, "console")).toBe(OP.toLowerCase());
  });

  it("turns a wallet that is not an operator away before asking it to prove anything", async () => {
    const r = await signIn(OP, issuedNow, { LUCRE_OPERATORS: OTHER });
    expect(r.status).toBe(403);
    expect(r.body).toMatchObject({ error: expect.stringContaining("not an operator") });
  });

  it("refuses a stale signature and a replayed one", async () => {
    const old = new Date((NOW - 3600) * 1000).toISOString();
    expect((await signIn(OP, old)).status).toBe(400);
    expect((await signIn(OP, issuedNow, {}, async () => true)).status).toBe(401);
  });

  it("refuses a signature that does not match the console's own message", async () => {
    // Signed over the coin-chat text, presented here.
    const nonce = "a1b2c3d4e5f60718";
    const signature = await account.signMessage({
      message: ["doubleplus.fun wants you to sign in to coin chat.", "", `Wallet: ${OP.toLowerCase()}`].join("\n"),
    });
    const r = new Request("https://api.invalid/lucre/auth", {
      method: "POST",
      body: JSON.stringify({ address: OP, issuedAt: issuedNow, nonce, signature }),
      headers: { "content-type": "application/json" },
    });
    expect((await consoleAuth(r, env(), NOW, never)).status).toBe(401);
  });

  it("rejects a malformed body", async () => {
    const r = new Request("https://api.invalid/lucre/auth", {
      method: "POST",
      body: JSON.stringify({ address: "nope" }),
      headers: { "content-type": "application/json" },
    });
    expect((await consoleAuth(r, env(), NOW, never)).status).toBe(400);
  });
});
