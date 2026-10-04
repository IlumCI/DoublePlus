/**
 * Pure pieces of the API: the sign-in message, session tokens and comment
 * text rules. No network, no env: tested directly in test/lib.test.ts.
 */

export const MAX_BODY = 280;
export const MAX_LINKS = 2;
export const SESSION_SECS = 7 * 86_400;
/** How far a signed-in timestamp may sit from the server clock. */
export const ISSUED_SKEW_SECS = 5 * 60;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (s: unknown): s is `0x${string}` => typeof s === "string" && ADDR.test(s);

export const NONCE = /^[0-9a-f]{16,64}$/;

/** The exact text a wallet signs to sign in. The site builds the same string.
 *  It names the domain, so a lookalike site asking for this signature is
 *  visibly asking to sign in to doubleplus.fun, and it carries a nonce, so
 *  each signature is unique and the worker can refuse it a second time. */
export function authMessage(address: string, issuedAt: string, nonce: string): string {
  return [
    "doubleplus.fun wants you to sign in to coin chat.",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "This signature only proves you own this wallet. It cannot move funds.",
  ].join("\n");
}

const enc = new TextEncoder();
const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function hmac(secret: string, data: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(data))));
}

/** `address.expiry.mac`: stateless, so the worker needs no session table. */
export async function issueSession(secret: string, address: string, nowSecs: number): Promise<{ token: string; expires: number }> {
  const expires = nowSecs + SESSION_SECS;
  const payload = `${address.toLowerCase()}.${expires}`;
  return { token: `${payload}.${await hmac(secret, payload)}`, expires };
}

/** The address a session token was issued to, or null if forged or expired. */
export async function readSession(secret: string, token: string, nowSecs: number): Promise<`0x${string}` | null> {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [address, exp, mac] = parts;
  if (!isAddr(address) || !/^\d+$/.test(exp) || Number(exp) < nowSecs) return null;
  const want = await hmac(secret, `${address}.${exp}`);
  // Constant-time compare: equal length is guaranteed for a well-formed mac.
  if (want.length !== mac.length) return null;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ mac.charCodeAt(i);
  return diff === 0 ? address : null;
}

/** Normalise a comment, or say why it is refused. */
export function cleanBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  if (typeof raw !== "string") return { ok: false, error: "empty comment" };
  const body = raw
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, "") // controls, zero-width, bidi overrides
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!body) return { ok: false, error: "empty comment" };
  if ([...body].length > MAX_BODY) return { ok: false, error: `keep it under ${MAX_BODY} characters` };
  const links = body.match(/https?:\/\/|www\./gi)?.length ?? 0;
  if (links > MAX_LINKS) return { ok: false, error: `at most ${MAX_LINKS} links` };
  return { ok: true, body };
}

/** Seconds a poster must wait between comments: holders and the dev talk more freely. */
export const cooldownSecs = (holderOrDev: boolean) => (holderOrDev ? 15 : 120);

/** Largest request body the API reads. A comment is 280 characters. */
export const MAX_REQUEST_BYTES = 4 * 1024;

/** Read a JSON body no larger than MAX_REQUEST_BYTES. Streams with a cap,
 *  so a chunked upload without Content-Length is cut off, not buffered. */
export async function readJson(req: Request): Promise<Record<string, unknown> | "too_big" | null> {
  const declared = Number(req.headers.get("Content-Length") ?? "0");
  if (declared > MAX_REQUEST_BYTES) return "too_big";
  if (!req.body) return null;
  const reader = req.body.getReader();
  const buf = new Uint8Array(MAX_REQUEST_BYTES);
  let n = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (n + value.byteLength > MAX_REQUEST_BYTES) {
        reader.cancel().catch(() => undefined);
        return "too_big";
      }
      buf.set(value, n);
      n += value.byteLength;
    }
    const v = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(buf.subarray(0, n)));
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch { return null; }
}

/** Shortest SESSION_SECRET the worker will sign with. */
export const MIN_SECRET_CHARS = 32;

/**
 * Paths no client of this API ever requests, which scanners always do. A hit
 * is logged and the address blocked for a day. Listed in robots.txt as
 * disallowed, which well-behaved crawlers respect and scanners read as a map.
 */
const TRAPS = [
  /^\/admin(\/|$)/i, /^\/internal(\/|$)/i, /^\/api\/v\d+\/(export|admin|keys|users)/i,
  /^\/\.(env|git|aws|ssh|svn|hg|DS_Store|htaccess|htpasswd|npmrc|docker)/i,
  /^\/(wp-|wordpress|phpmyadmin|pma|xmlrpc\.php|cgi-bin|server-status|actuator|console|jenkins|solr|_profiler)/i,
  /\.(php|asp|aspx|jsp|cgi|sql|bak|old|swp|zip|tar|gz|7z|pem|key|env|ini|yml|yaml|config)$/i,
  /^\/(backup|dump|db|database|config|credentials|secrets?)(\.|\/|$)/i,
  /^\/(graphql|debug|swagger|openapi|metrics)(\/|\.|$)/i,
];
export const isTrap = (path: string): boolean => TRAPS.some((re) => re.test(path));

/** The decoy service key served on a bait page. Nothing accepts it; anyone
 *  presenting it later has crawled the bait and is trying it on purpose. */
export const DECOY_KEY = "dpk_live_7f3c9a1e5b8d2f6a4c0e9b7d3a5f1c8e";
export const carriesDecoy = (headers: Headers, url: URL): boolean => {
  const hay = [headers.get("Authorization"), headers.get("apikey"), headers.get("X-Api-Key"), url.search].join(" ");
  return hay.includes(DECOY_KEY);
};
