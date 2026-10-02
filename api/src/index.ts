import { createPublicClient, http, parseAbi, verifyMessage, type Address } from "viem";

import { authMessage, cleanBody, cooldownSecs, isAddr, ISSUED_SKEW_SECS, issueSession, readSession } from "./lib";

/**
 * doubleplus.fun API: token comment threads.
 *
 *   POST /auth      { address, issuedAt, signature }  -> { token, expires }
 *   GET  /comments?token=0x…&before=<id>              -> { comments: [...] }
 *   POST /comments  { token, body }  (Bearer session)  -> { comment }
 *
 * Supabase is storage only, reached with the service key; the table has RLS
 * on and no policies, so this worker is the only way in. Every write is tied
 * to a wallet that signed in, checked against the chain (the token must be a
 * doubleplus launch; holder and dev badges come from balanceOf and the
 * factory listing), and rate-limited per author.
 */

export interface Env {
  SUPABASE_URL: string;
  SUPABASE_SERVICE_KEY: string;
  SESSION_SECRET: string;
  RPC_URL: string;
  FACTORY: string;
  ALLOWED_ORIGINS: string;
}

const FACTORY_ABI = parseAbi([
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
]);
const ERC20_ABI = parseAbi(["function balanceOf(address) view returns (uint256)"]);

const PAGE = 50;
const now = () => Math.floor(Date.now() / 1000);

function cors(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const allowed = env.ALLOWED_ORIGINS.split(",").map((s) => s.trim()).filter(Boolean);
  return allowed.includes(origin)
    ? { "Access-Control-Allow-Origin": origin, Vary: "Origin", "Access-Control-Allow-Headers": "Content-Type, Authorization", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" }
    : {};
}

const json = (data: unknown, status: number, headers: Record<string, string>) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json", ...headers } });

/** PostgREST call with the service key. New-style sb_secret_ keys go in apikey only. */
function db(env: Env, path: string, init: RequestInit = {}) {
  const key = env.SUPABASE_SERVICE_KEY;
  const headers: Record<string, string> = { apikey: key, "Content-Type": "application/json", ...(init.headers as Record<string, string>) };
  if (!key.startsWith("sb_")) headers.Authorization = `Bearer ${key}`;
  return fetch(`${env.SUPABASE_URL}/rest/v1/${path}`, { ...init, headers });
}

async function auth(req: Request, env: Env, h: Record<string, string>) {
  const { address, issuedAt, signature } = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isAddr(address) || typeof issuedAt !== "string" || typeof signature !== "string") return json({ error: "bad request" }, 400, h);
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(t / 1000 - now()) > ISSUED_SKEW_SECS) return json({ error: "signature expired, sign again" }, 400, h);
  const ok = await verifyMessage({ address: address as Address, message: authMessage(address, issuedAt), signature: signature as `0x${string}` }).catch(() => false);
  if (!ok) return json({ error: "signature does not match" }, 401, h);
  return json(await issueSession(env.SESSION_SECRET, address, now()), 200, h);
}

async function list(url: URL, env: Env, h: Record<string, string>) {
  const token = url.searchParams.get("token")?.toLowerCase();
  if (!isAddr(token)) return json({ error: "bad token" }, 400, h);
  const before = url.searchParams.get("before");
  let q = `comments?select=id,author,body,holder,is_dev,created_at&token=eq.${token}&hidden=is.false&order=id.desc&limit=${PAGE}`;
  if (before && /^\d+$/.test(before)) q += `&id=lt.${before}`;
  const r = await db(env, q);
  if (!r.ok) return json({ error: "storage unavailable" }, 502, h);
  // Short edge cache: a busy thread is polled by every open page.
  return json({ comments: await r.json() }, 200, { ...h, "Cache-Control": "public, max-age=5" });
}

async function post(req: Request, env: Env, h: Record<string, string>) {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const author = await readSession(env.SESSION_SECRET, bearer, now());
  if (!author) return json({ error: "sign in again" }, 401, h);

  const { token: rawToken, body: rawBody } = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (!isAddr(rawToken)) return json({ error: "bad token" }, 400, h);
  const token = rawToken.toLowerCase();
  const cleaned = cleanBody(rawBody);
  if (!cleaned.ok) return json({ error: cleaned.error }, 400, h);

  const pc = createPublicClient({ transport: http(env.RPC_URL) });
  const [listing, balance] = await Promise.all([
    pc.readContract({ address: env.FACTORY as Address, abi: FACTORY_ABI, functionName: "listings", args: [token as Address] }),
    pc.readContract({ address: token as Address, abi: ERC20_ABI, functionName: "balanceOf", args: [author as Address] }).catch(() => 0n),
  ]).catch(() => [null, 0n] as const);
  if (!listing) return json({ error: "chain unavailable, try again" }, 502, h);
  const creator = String(listing[0]).toLowerCase();
  if (creator === "0x0000000000000000000000000000000000000000") return json({ error: "not a doubleplus coin" }, 404, h);
  const isDev = creator === author;
  const holder = balance > 0n;

  const last = await db(env, `comments?select=created_at&author=eq.${author}&order=id.desc&limit=1`);
  if (!last.ok) return json({ error: "storage unavailable" }, 502, h);
  const [prev] = (await last.json()) as { created_at: string }[];
  const wait = prev ? cooldownSecs(holder || isDev) - (now() - Math.floor(Date.parse(prev.created_at) / 1000)) : 0;
  if (wait > 0) return json({ error: `slow down: ${wait}s`, retryAfter: wait }, 429, h);

  const ins = await db(env, "comments?select=id,author,body,holder,is_dev,created_at", {
    method: "POST",
    headers: { Prefer: "return=representation" },
    body: JSON.stringify({ token, author, body: cleaned.body, holder, is_dev: isDev }),
  });
  if (!ins.ok) return json({ error: "could not save" }, 502, h);
  const [comment] = await ins.json() as unknown[];
  return json({ comment }, 201, h);
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const h = cors(req, env);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: h });
    const url = new URL(req.url);
    try {
      if (url.pathname === "/health") return json({ ok: true }, 200, h);
      if (url.pathname === "/auth" && req.method === "POST") return await auth(req, env, h);
      if (url.pathname === "/comments" && req.method === "GET") return await list(url, env, h);
      if (url.pathname === "/comments" && req.method === "POST") return await post(req, env, h);
      return json({ error: "not found" }, 404, h);
    } catch {
      return json({ error: "server error" }, 500, h);
    }
  },
};
