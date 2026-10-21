/**
 * The launch console's back half: the only thing on the public internet that
 * holds the Lucreocracy service token.
 *
 * The pipeline used to be a CLI, and the CLI's real protection was that you
 * had to be on the machine with a shell. Putting it behind the website means
 * replacing that with something a browser cannot defeat, so the token lives
 * here as a worker secret and the browser never sees it. A visitor's authority
 * is a wallet signature, checked against an operator allowlist, and the
 * signature they give says in its own text that it authorises launches that
 * spend ETH — a coin-chat sign-in does not carry that scope and will not open
 * this door.
 *
 * What a browser may ask for is an allowlist too. Fields it does not name are
 * dropped rather than forwarded, so a field added to the service later cannot
 * be reached from a browser the day it ships.
 *
 * Nothing here decides how much may be spent. That is the service's own
 * per-grant budget, which is the backstop under all of this: an allowlisted
 * wallet whose session is stolen can still only spend what the grant allows.
 */

import { verifyMessage, type Hex } from "viem";

import { consoleAuthMessage, isAddr, ISSUED_SKEW_SECS, issueSession, NONCE, readJson, readSession } from "./lib";

export interface LucreEnv {
  /** The Lucreocracy service, e.g. https://lucre.internal:8080. */
  LUCRE_URL?: string;
  /** That tenant's bearer token. A worker secret, never a var. */
  LUCRE_TOKEN?: string;
  /** Wallets that may drive the pipeline, comma-separated. */
  LUCRE_OPERATORS?: string;
  /** "1" lets a request from the console ask for a real launch. Off by
   *  default: a launchpad that has not decided this yet should design only. */
  LUCRE_ALLOW_LIVE?: string;
  SESSION_SECRET: string;
}

/** What a browser may put in a run request. Everything else is dropped.
 *
 *  `live` is handled separately, because whether a browser may ask for it at
 *  all is a deployment decision rather than a field. */
const ALLOWED_FIELDS = ["profile", "topic", "firstBuyWei", "designOnly", "tax", "minHoldForDividends", "dividendMode"] as const;

/** Service routes the console may reach, and how. Anything else is 404 here
 *  rather than being passed along to find out. */
const ROUTES: { method: "GET" | "POST"; pattern: RegExp; to: (m: RegExpMatchArray) => string }[] = [
  { method: "GET", pattern: /^\/ready$/, to: () => "/ready" },
  { method: "GET", pattern: /^\/profiles$/, to: () => "/profiles" },
  { method: "GET", pattern: /^\/budget$/, to: () => "/budget" },
  { method: "GET", pattern: /^\/income$/, to: () => "/income" },
  { method: "GET", pattern: /^\/loop$/, to: () => "/loop" },
  { method: "GET", pattern: /^\/runs$/, to: () => "/runs" },
  { method: "GET", pattern: /^\/runs\/([0-9a-fA-F-]{36})$/, to: (m) => `/runs/${m[1]}` },
  { method: "POST", pattern: /^\/runs$/, to: () => "/runs" },
  { method: "POST", pattern: /^\/runs\/([0-9a-fA-F-]{36})\/cancel$/, to: (m) => `/runs/${m[1]}/cancel` },
  { method: "POST", pattern: /^\/loop\/start$/, to: () => "/loop/start" },
  { method: "POST", pattern: /^\/loop\/stop$/, to: () => "/loop/stop" },
];

export function matchRoute(method: string, path: string): string | null {
  for (const r of ROUTES) {
    if (r.method !== method) continue;
    const m = path.match(r.pattern);
    if (m) return r.to(m);
  }
  return null;
}

export const operators = (env: LucreEnv): string[] =>
  (env.LUCRE_OPERATORS ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => isAddr(s));

export const isOperator = (env: LucreEnv, address: string): boolean => operators(env).includes(address.toLowerCase());

export const allowsLive = (env: LucreEnv): boolean => (env.LUCRE_ALLOW_LIVE ?? "").trim() === "1";

/** Keep only the fields a browser is allowed to choose, and settle `live`.
 *
 *  A console that asked for a live launch on a deployment that does not permit
 *  one is answered rather than silently downgraded: a caller who believes it
 *  launched would go looking for a coin that does not exist. */
export function narrowRunBody(
  body: Record<string, unknown>,
  env: LucreEnv,
): { ok: true; body: Record<string, unknown> } | { ok: false; error: string } {
  const out: Record<string, unknown> = {};
  for (const f of ALLOWED_FIELDS) if (f in body) out[f] = body[f];
  if (body.live !== undefined && typeof body.live !== "boolean") return { ok: false, error: "live must be a boolean" };
  if (body.live === true) {
    if (!allowsLive(env)) {
      return { ok: false, error: "this launchpad's console is set to design only; it cannot ask for a live launch" };
    }
    out.live = true;
  }
  return { ok: true, body: out };
}

/** Sign in to the console. The same wallet proof as coin chat, with its own
 *  message and its own session scope. */
export async function consoleAuth(
  req: Request,
  env: LucreEnv,
  nowSecs: number,
  seen: (sig: Hex) => Promise<boolean>,
): Promise<{ status: number; body: unknown }> {
  const b = await readJson(req);
  if (b === "too_big") return { status: 413, body: { error: "too large" } };
  const { address, issuedAt, nonce, signature } = b ?? {};
  if (
    !isAddr(address) ||
    typeof issuedAt !== "string" ||
    typeof nonce !== "string" ||
    !NONCE.test(nonce) ||
    typeof signature !== "string" ||
    !/^0x[0-9a-fA-F]{130}$/.test(signature)
  ) {
    return { status: 400, body: { error: "bad request" } };
  }
  // Checked before the signature, so a wallet that is not an operator is told
  // so rather than being asked to prove it owns a wallet that cannot help it.
  if (!isOperator(env, address)) return { status: 403, body: { error: "this wallet is not an operator of this launchpad" } };
  const t = Date.parse(issuedAt);
  if (!Number.isFinite(t) || Math.abs(t / 1000 - nowSecs) > ISSUED_SKEW_SECS) {
    return { status: 400, body: { error: "signature expired, sign again" } };
  }
  const ok = await verifyMessage({
    address,
    message: consoleAuthMessage(address, issuedAt, nonce),
    signature: signature as Hex,
  }).catch(() => false);
  if (!ok) return { status: 401, body: { error: "signature does not match" } };
  if (await seen(signature as Hex)) return { status: 401, body: { error: "signature already used, sign again" } };
  return { status: 200, body: await issueSession(env.SESSION_SECRET, address, nowSecs, "console") };
}

export interface ProxyResult {
  status: number;
  body: unknown;
  /** The operator this call was made as, for the request log. */
  as?: string;
}

/** Forward one console call to the service.
 *
 *  `fetchImpl` is injected so this is testable without a service behind it. */
export async function proxy(args: {
  req: Request;
  env: LucreEnv;
  /** Path under /lucre, e.g. "/runs". */
  path: string;
  nowSecs: number;
  fetchImpl?: typeof fetch;
}): Promise<ProxyResult> {
  const { req, env, path, nowSecs } = args;
  const base = (env.LUCRE_URL ?? "").replace(/\/+$/, "");
  // Fail shut: an unconfigured console is a closed door, not an open one.
  if (!base || !env.LUCRE_TOKEN) {
    return { status: 503, body: { error: "the launch console is not configured on this deployment" } };
  }

  if (path === "/auth" && req.method === "POST") {
    return { status: 400, body: { error: "sign in at /lucre/auth" } };
  }

  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? "";
  const who = await readSession(env.SESSION_SECRET, bearer, nowSecs, "console");
  if (!who) return { status: 401, body: { error: "sign in to the console again" } };
  // The allowlist is read on every call, not just at sign-in, so removing a
  // wallet takes effect at once rather than when its session expires.
  if (!isOperator(env, who)) return { status: 403, body: { error: "this wallet is no longer an operator" } };

  const target = matchRoute(req.method, path);
  if (!target) return { status: 404, body: { error: `the console does not expose ${req.method} ${path}` }, as: who };

  let payload: string | undefined;
  if (req.method === "POST") {
    const raw = await readJson(req);
    if (raw === "too_big") return { status: 413, body: { error: "too large" }, as: who };
    const narrowed = narrowRunBody(raw ?? {}, env);
    if (!narrowed.ok) return { status: 403, body: { error: narrowed.error }, as: who };
    payload = JSON.stringify(narrowed.body);
  }

  const doFetch = args.fetchImpl ?? fetch;
  let res: Response;
  try {
    res = await doFetch(`${base}${target}`, {
      method: req.method,
      headers: {
        authorization: `Bearer ${env.LUCRE_TOKEN}`,
        ...(payload ? { "content-type": "application/json" } : {}),
      },
      ...(payload ? { body: payload } : {}),
    });
  } catch (e) {
    return { status: 502, body: { error: `the launch service did not answer: ${(e as Error).message}` }, as: who };
  }
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    // Anything that is not the service's own JSON is not passed to a browser
    // verbatim: it is as likely to be a proxy's error page as a useful reply.
    return { status: 502, body: { error: "the launch service answered with something other than JSON" }, as: who };
  }
  return { status: res.status, body, as: who };
}
