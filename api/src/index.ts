import { createPublicClient, http, keccak256, parseAbi, verifyMessage, zeroAddress, type Address, type Hex } from "viem";

import {
  authMessage, carriesDecoy, cleanBody, cooldownSecs, DECOY_KEY, isAddr, isTrap, ISSUED_SKEW_SECS, issueSession,
  MIN_SECRET_CHARS, NONCE, readJson, readSession,
} from "./lib";

/**
 * doubleplus.fun API: token comment threads.
 *
 *   POST /auth      { address, issuedAt, nonce, signature }  -> { token, expires }
 *   GET  /comments?token=0x…&before=<id>                     -> { comments: [...] }
 *   POST /comments  { token, body }  (Bearer session)         -> { comment }
 *
 * Supabase is storage only, reached with the service key; the tables have RLS
 * on and no policies, so this worker is the only way in. Every write is tied
 * to a wallet that signed in, checked against the chain (the token must be a
 * doubleplus launch; holder and dev badges come from balanceOf and the
 * factory listing), and rate-limited per author inside the database.
 *
 * Defences, outermost first: a per-IP blocklist (KV), honeypot paths and a
 * decoy key that feed it, per-IP rate limits, a body size cap, origin and
 * content-type checks on writes, one-time domain-bound sign-in signatures, a
 * hidden form field only bots fill, and a structured log line per request.
 */

interface RateLimiter { limit(o: { key: string }): Promise<{ success: boolean }> }

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SESSION_SECRET: string;
  RPC_URL: string;
  FACTORY: string;
  ALLOWED_ORIGINS: string;
  GUARD: KVNamespace;
  RL_READ: RateLimiter;
  RL_WRITE: RateLimiter;
  RL_AUTH: RateLimiter;
}

const FACTORY_ABI = parseAbi([
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const PAGE = 50;
const BLOCK_SECS = 86_400;
const now = () => Math.floor(Date.now() / 1000);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Per-request context: who is asking and what happened, logged once. */
interface Ctx {
  req: Request;
  url: URL;
  ip: string;
  ua: string;
  country: string;
  started: number;
  event?: string;
  detail?: Record<string, unknown>;
  wait: (p: Promise<unknown>) => void;
}

const SECURITY_HEADERS: Record<string, string> = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "cross-origin",
};

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  return allowedOrigin(origin, env)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Max-Age": "600" }
    : {};
}
const allowedOrigin = (origin: string, env: Env) =>
  env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean).includes(origin);

const json = (data: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...SECURITY_HEADERS, ...headers } });

/** PostgREST call with the service key. New-style sb_secret_ keys go in apikey only. */
function db(env: Env, path: string, init: RequestInit = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

/** Durable record of a security event, written after the response goes out. */
function record(env: Env, c: Ctx, kind: string, detail: Record<string, unknown> = {}) {
  c.event = kind;
  c.detail = detail;
  c.wait(db(env, "security_events", {
    method: "POST",
    body: JSON.stringify({ kind, ip: c.ip.slice(0, 64), path: c.url.pathname.slice(0, 300), ua: c.ua.slice(0, 300), country: c.country.slice(0, 8), detail }),
  }).catch(() => undefined));
}

async function block(env: Env, c: Ctx, reason: string) {
  try {
    if (!(await env.GUARD.get(`ip:${c.ip}`))) {
      await env.GUARD.put(`ip:${c.ip}`, JSON.stringify({ reason, at: now() }), { expirationTtl: BLOCK_SECS });
    }
  } catch { /* KV unavailable or out of writes: the event is still recorded */ }
}

async function auth(env: Env, c: Ctx, h: Record<string, string>) {
  const b = await readJson(c.req);
  if (b === "too_big") return json({ error: "too large" }, 413, h);
  const { address, issuedAt, nonce, signature } = b ?? {};
  if (!isAddr(address) || typeof issuedAt !== "string" || typeof nonce !== "string" || !NONCE.test(nonce)
    || typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) {
    return json({ error: "bad request" }, 400, h);
  }
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(t / 1000 - now()) > ISSUED_SKEW_SECS) return json({ error: "signature expired, sign again" }, 400, h);
  const ok = await verifyMessage({ address, message: authMessage(address, issuedAt, nonce), signature: signature as Hex }).catch(() => false);
  if (!ok) {
    record(env, c, "auth_bad_signature", { address });
    return json({ error: "signature does not match" }, 401, h);
  }
  // One use per signature: a copied or phished signature can't be replayed.
  const used = `sig:${keccak256(signature as Hex)}`;
  try {
    if (await env.GUARD.get(used)) {
      record(env, c, "auth_replay", { address });
      return json({ error: "signature already used, sign again" }, 401, h);
    }
    await env.GUARD.put(used, "1", { expirationTtl: ISSUED_SKEW_SECS * 3 });
  } catch { /* KV unavailable: fall back to the timestamp window alone */ }
  return json(await issueSession(env.SESSION_SECRET, address, now()), 200, { ...h, "Cache-Control": "no-store" });
}

async function list(env: Env, c: Ctx, h: Record<string, string>) {
  const token = c.url.searchParams.get("token")?.toLowerCase();
  if (!isAddr(token)) return json({ error: "bad token" }, 400, h);
  const before = c.url.searchParams.get("before");
  if (before !== null && !/^\d{1,18}$/.test(before)) return json({ error: "bad cursor" }, 400, h);

  // Every open coin page polls this; serve repeats from the edge cache so
  // a flood of reads costs the database one query per thread per 5 seconds.
  const cacheKey = new Request(`https://cache.doubleplus/comments?token=${token}&before=${before ?? ""}`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey).catch(() => undefined);
  if (hit) {
    const r = new Response(hit.body, hit);
    for (const [k, v] of Object.entries(h)) r.headers.set(k, v);
    r.headers.set("X-Cache", "HIT");
    return r;
  }
  let q = `comments?select=id,author,body,holder,is_dev,created_at&token=eq.${token}&hidden=is.false&order=id.desc&limit=${PAGE}`;
  if (before) q += `&id=lt.${before}`;
  const r = await db(env, q);
  if (!r.ok) return json({ error: "storage unavailable" }, 502, h);
  const res = json({ comments: await r.json() }, 200, { ...h, "Cache-Control": "public, max-age=5" });
  c.wait(cache.put(cacheKey, res.clone()).catch(() => undefined));
  return res;
}

async function post(env: Env, c: Ctx, h: Record<string, string>) {
  const bearer = c.req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const author = await readSession(env.SESSION_SECRET, bearer, now());
  if (!author) {
    if (bearer) record(env, c, "session_invalid");
    return json({ error: "sign in again" }, 401, h);
  }
  if (!(await env.RL_WRITE.limit({ key: `author:${author}` })).success) return json({ error: "slow down" }, 429, h);

  const b = await readJson(c.req);
  if (b === "too_big") return json({ error: "too large" }, 413, h);
  const { token: rawToken, body: rawBody, website } = b ?? {};
  // A field the form hides from people. Bots fill every field they find.
  if (typeof website === "string" && website.length > 0) {
    record(env, c, "bot_form", { author });
    await block(env, c, "bot_form");
    return json({ comment: { id: 0, author, body: String(rawBody ?? "").slice(0, 280), holder: false, is_dev: false, created_at: new Date().toISOString() } }, 201, h);
  }
  if (!isAddr(rawToken)) return json({ error: "bad token" }, 400, h);
  const token = rawToken.toLowerCase() as Address;
  const cleaned = cleanBody(rawBody);
  if (!cleaned.ok) return json({ error: cleaned.error }, 400, h);

  const pc = createPublicClient({ transport: http(env.RPC_URL) });
  const factory = env.FACTORY;
  if (!isAddr(factory)) throw new Error("FACTORY is not an address");
  const [listing, balance] = await Promise.all([
    pc.readContract({ address: factory, abi: FACTORY_ABI, functionName: "listings", args: [token] }),
    pc.readContract({ address: token, abi: ERC20_ABI, functionName: "balanceOf", args: [author] }).catch(() => 0n),
  ]).catch(() => [null, 0n] as const);
  if (!listing) return json({ error: "chain unavailable, try again" }, 502, h);
  const creator = listing[0].toLowerCase();
  if (creator === zeroAddress) return json({ error: "not a doubleplus coin" }, 404, h);
  const isDev = creator === author;
  const holder = balance > 0n;

  // Cooldown and insert in one transaction, serialised per author.
  const ins = await db(env, "rpc/post_comment", {
    method: "POST",
    body: JSON.stringify({ p_token: token, p_author: author, p_body: cleaned.body, p_holder: holder, p_is_dev: isDev, p_cooldown: cooldownSecs(holder || isDev) }),
  });
  if (!ins.ok) {
    const err = (await ins.json().catch(() => ({}))) as { message?: string };
    const m = /^cooldown:(\d+)/.exec(err.message ?? "");
    if (m) return json({ error: `slow down: ${m[1]}s`, retryAfter: Number(m[1]) }, 429, h);
    return json({ error: "could not save" }, 502, h);
  }
  const row = (await ins.json()) as Record<string, unknown>;
  const { id, author: a, body: bd, holder: ho, is_dev, created_at } = row;
  return json({ comment: { id, author: a, body: bd, holder: ho, is_dev, created_at } }, 201, h);
}

/** What a scanner finds when it follows robots.txt: plausible, and poisoned. */
function bait(c: Ctx): Response {
  if (/^\/internal\/config/i.test(c.url.pathname)) {
    return json({
      service: "dp-internal", region: "eu-central-1",
      supabase: { url: "https://db-internal.doubleplus.fun", service_key: DECOY_KEY },
      note: "rotate before launch",
    }, 200, {});
  }
  return json({ error: "unauthorized" }, 401, { "WWW-Authenticate": 'Bearer realm="admin"' });
}

const ROBOTS = "User-agent: *\nDisallow: /admin/\nDisallow: /internal/\nDisallow: /internal/config\nDisallow: /api/v1/export\n";

async function route(env: Env, c: Ctx): Promise<Response> {
  const { req, url } = c;
  const h = cors(req, env);

  // Already blocked: a slow, empty refusal.
  try {
    if (await env.GUARD.get(`ip:${c.ip}`)) {
      c.event = "blocked";
      await sleep(1500);
      return new Response(null, { status: 403, headers: SECURITY_HEADERS });
    }
  } catch { /* fail open: KV down must not take the API down */ }

  // The decoy key, anywhere in the request: someone used what the bait gave them.
  if (carriesDecoy(req.headers, url)) {
    record(env, c, "decoy_key_used", { method: req.method });
    await block(env, c, "decoy_key");
    await sleep(2000);
    return json({ error: "unauthorized" }, 401, {});
  }

  if (url.pathname === "/robots.txt") return new Response(ROBOTS, { headers: { "Content-Type": "text/plain", ...SECURITY_HEADERS } });
  if (isTrap(url.pathname)) {
    record(env, c, "honeypot", { method: req.method });
    await block(env, c, "honeypot");
    await sleep(800 + Math.floor(Math.random() * 1200)); // tarpit
    return bait(c);
  }

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...h, ...SECURITY_HEADERS } });
  if (url.pathname === "/health") return json({ ok: true }, 200, h);

  // Writes come from the site, as JSON. A browser always sends Origin.
  if (req.method === "POST") {
    if (!allowedOrigin(req.headers.get("Origin") ?? "", env)) {
      record(env, c, "bad_origin", { origin: (req.headers.get("Origin") ?? "").slice(0, 120) });
      return json({ error: "forbidden" }, 403, h);
    }
    if (!(req.headers.get("Content-Type") ?? "").toLowerCase().startsWith("application/json")) {
      return json({ error: "send JSON" }, 415, h);
    }
  }

  const limiter = req.method === "GET" ? env.RL_READ : url.pathname === "/auth" ? env.RL_AUTH : env.RL_WRITE;
  if (!(await limiter.limit({ key: `ip:${c.ip}` })).success) {
    c.event = "rate_limited";
    return json({ error: "slow down" }, 429, { ...h, "Retry-After": "60" });
  }

  // A missing or short secret would sign sessions anyone can forge: refuse
  // sign-in and posting rather than run that way.
  if ((url.pathname === "/auth" || req.method === "POST") && (env.SESSION_SECRET ?? "").length < MIN_SECRET_CHARS) {
    throw new Error("SESSION_SECRET is missing or too short");
  }

  if (url.pathname === "/auth" && req.method === "POST") return auth(env, c, h);
  if (url.pathname === "/comments" && req.method === "GET") return list(env, c, h);
  if (url.pathname === "/comments" && req.method === "POST") return post(env, c, h);
  return json({ error: "not found" }, 404, h);
}

export default {
  async fetch(req: Request<unknown, IncomingRequestCfProperties>, env: Env, ctx: ExecutionContext): Promise<Response> {
    const c: Ctx = {
      req, url: new URL(req.url),
      ip: req.headers.get("CF-Connecting-IP") ?? "unknown",
      ua: req.headers.get("User-Agent") ?? "",
      country: String(req.cf?.country ?? ""),
      started: Date.now(),
      wait: (p) => ctx.waitUntil(p),
    };
    let res: Response;
    try {
      res = await route(env, c);
    } catch (e) {
      c.event = "error";
      c.detail = { message: String(e instanceof Error ? e.message : e).slice(0, 300) };
      res = json({ error: "server error" }, 500, cors(req, env));
    }
    // One structured line per request, for Workers Logs.
    console.log(JSON.stringify({
      t: new Date().toISOString(), m: req.method, p: c.url.pathname, s: res.status, ms: Date.now() - c.started,
      ip: c.ip, cc: c.country, ua: c.ua.slice(0, 120), ev: c.event, d: c.detail,
    }));
    return res;
  },
};
