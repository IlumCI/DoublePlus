/**
 * The launch console's front half.
 *
 * Everything here goes through the API worker at /lucre, which is the only
 * thing that holds the Lucreocracy service token. This file never sees it, and
 * a page that did would be handing it to every visitor's browser.
 *
 * A console session is a separate sign-in from coin chat, with its own message
 * text, because signing in to talk on a coin page is not consent to spend ETH
 * on launches. The worker refuses a chat session here and this refuses to
 * reuse one.
 */

const API = String(import.meta.env.VITE_VENTURE_API_URL ?? "").replace(/\/$/, "");
export const CONSOLE_ENABLED = API !== "";

/** Must match api/src/lib.ts consoleAuthMessage exactly: the worker verifies
 *  this text, and a wallet owner reads it before signing. */
export function consoleAuthMessage(address: string, issuedAt: string, nonce: string): string {
  return [
    "doubleplus.fun wants you to sign in to the launch console.",
    "",
    `Wallet: ${address.toLowerCase()}`,
    `Issued at: ${issuedAt}`,
    `Nonce: ${nonce}`,
    "",
    "Signing in lets this wallet design and launch coins on this launchpad,",
    "which spends the operator's ETH on opening buys.",
    "This signature cannot move funds by itself.",
  ].join("\n");
}

export function newNonce(): string {
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

// Kept apart from the chat session on purpose: one is not the other, and a
// shared key would let a chat sign-in masquerade as console authority here
// even though the worker would still refuse it.
const key = (a: string) => `dp-console:${a.toLowerCase()}`;

export function readConsoleSession(a: string): string | null {
  try {
    const raw = localStorage.getItem(key(a));
    if (!raw) return null;
    const { token, expires } = JSON.parse(raw) as { token?: unknown; expires?: unknown };
    return typeof token === "string" && typeof expires === "number" && expires > Date.now() / 1000 + 60 ? token : null;
  } catch {
    return null;
  }
}

export function writeConsoleSession(a: string, token: string, expires: number): void {
  try {
    localStorage.setItem(key(a), JSON.stringify({ token, expires }));
  } catch {
    /* private mode: sign in again next time */
  }
}

export function dropConsoleSession(a: string): void {
  try {
    localStorage.removeItem(key(a));
  } catch {
    /* ignore */
  }
}

/** True once this browser has held a console session, which is how the nav
 *  entry stays invisible to everyone who is not an operator. */
export function hasConsoleSession(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith("dp-console:")) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export class ConsoleError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const trim = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** One call to the console. Throws ConsoleError with the worker's own words,
 *  because a budget refusal or a design-only refusal is the operator's answer
 *  and paraphrasing it would lose the number they need. */
export async function call<T>(path: string, token: string, body?: unknown): Promise<T> {
  const r = await fetch(`${API}/lucre${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) {
    throw new ConsoleError(typeof j.error === "string" ? trim(j.error) : `request failed (${r.status})`, r.status);
  }
  return j as T;
}

/** Sign in, or return the session this browser already holds. */
export async function signIn(
  address: string,
  sign: (message: string) => Promise<string>,
): Promise<string> {
  const issuedAt = new Date().toISOString();
  const nonce = newNonce();
  const signature = await sign(consoleAuthMessage(address, issuedAt, nonce));
  const r = await fetch(`${API}/lucre/auth`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, issuedAt, nonce, signature }),
  });
  const j = (await r.json().catch(() => ({}))) as { token?: unknown; expires?: unknown; error?: unknown };
  if (!r.ok || typeof j.token !== "string" || typeof j.expires !== "number") {
    throw new ConsoleError(typeof j.error === "string" ? trim(j.error, 200) : "sign-in failed", r.status);
  }
  writeConsoleSession(address, j.token, j.expires);
  return j.token;
}

export interface Budget {
  launches: number;
  spentWei: string;
  maxLaunches?: number;
  maxSpendWei?: string;
  launchesLeft?: number;
  spendLeftWei?: string;
  broken?: string;
}

export interface Ready {
  tenant: string;
  chainId: number;
  launcher: string;
  factory: string;
  model: string;
  profiles: number;
  /** Whether a live launch is possible at all on this deployment. */
  canSign: boolean;
  maySign: boolean;
  budget: Budget;
  loop: LoopState;
}

export interface LoopState {
  running: boolean;
  startedAt?: number;
  finishedAt?: number;
  launches: number;
  stopped?: string;
  note?: string;
  incomeEthWei?: string;
  spentEthWei?: string;
}

export interface Run {
  id: string;
  state: "queued" | "running" | "done" | "failed" | "cancelled";
  live: boolean;
  startedAt: number;
  finishedAt?: number;
  log: string[];
  logTruncated: boolean;
  result?: {
    specId: string;
    brief: string;
    name: string;
    ticker: string;
    lines: number;
    token?: string;
    txHash?: string;
    dryRun: boolean;
    dir: string;
    bundleDir?: string;
  };
  error?: string;
}

export interface SpecIncome {
  specId: string;
  coins: number;
  graduated: number;
  totalEthWei: string;
  meanTurnoverSecs: number | null;
  turnoversComplete: number;
}

export interface Income {
  totalEthWei: string;
  specs: SpecIncome[];
  coins: { token: string; specId: string; graduated: boolean; totalEthWei: string; swaps: number }[];
}

/** What the design form may send. Deliberately the same shape the worker
 *  allows: a field this does not name cannot be reached from a browser. */
export interface RunRequest {
  profile?: string;
  topic?: string;
  firstBuyWei?: string;
  designOnly?: boolean;
  live?: boolean;
}

export const ethFromWei = (wei: string, digits = 5): string => {
  const v = Number(wei) / 1e18;
  if (v === 0) return "0";
  if (v < 0.00001) return v.toExponential(2);
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
};

/** ETH as a decimal string, in wei. Parsed here rather than with Number, so a
 *  figure typed into the form is not rounded on its way to a launch. */
export function weiFromEth(input: string): { ok: true; wei: string } | { ok: false; error: string } {
  const v = input.trim();
  if (!v) return { ok: true, wei: "0" };
  if (!/^\d+(\.\d{1,18})?$/.test(v)) return { ok: false, error: "an ETH amount, like 0.005" };
  const [whole = "0", frac = ""] = v.split(".");
  return { ok: true, wei: (BigInt(whole) * 10n ** 18n + BigInt(frac.padEnd(18, "0"))).toString() };
}
