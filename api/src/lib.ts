/**
 * Pure pieces of the API: the sign-in message, session tokens and comment
 * text rules. No network, no env: tested directly in test/lib.test.ts.
 */

export const MAX_BODY = 280;
export const MAX_LINKS = 2;
export const SESSION_SECS = 7 * 86_400;
/** How far a signed-in timestamp may sit from the server clock. */
export const ISSUED_SKEW_SECS = 10 * 60;

const ADDR = /^0x[0-9a-fA-F]{40}$/;
export const isAddr = (s: unknown): s is string => typeof s === "string" && ADDR.test(s);

/** The exact text a wallet signs to sign in. The site builds the same string. */
export function authMessage(address: string, issuedAt: string): string {
  return [
    "doubleplus.fun comments",
    "",
    `Sign in as ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
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
export async function readSession(secret: string, token: string, nowSecs: number): Promise<string | null> {
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
