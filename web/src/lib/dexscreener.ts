import { useEffect, useState } from "react";
import type { Address } from "viem";

/** DEX Screener Enhanced Token Info — "is this token's profile paid for", and
 *  the canonical link to a token's pair page.
 *
 *  DEX Screener sells a token profile: pay once, and their CMS starts holding
 *  a logo, a banner, a description and social links for that token, which
 *  their UI then renders on the pair page. Traders read the presence of that
 *  profile as the cheapest available proof that somebody stood behind the
 *  token with their own money, so the badge is worth showing. It is evidence
 *  of spend, not of honesty: rug-pull detection work (arXiv 2608.01609)
 *  treats off-chain disclosure as one dimension beside contract design,
 *  on-chain anomalies and liquidity manipulation, never as a verdict. The
 *  copy in the UI says "paid", and nothing stronger.
 *
 *  Two endpoints carry the signal:
 *    GET /orders/v1/{chain}/{token}      the paid-order record (authoritative)
 *    GET /latest/dex/tokens/{addresses}  the pairs, each with the CMS `info`
 *
 *  The order feed is the source of truth; the `info` block is the payload the
 *  payment unlocks, and is also the only signal available in bulk, which is
 *  what the board needs.
 *
 *  Lifecycle matters. DEX Screener indexes pairs, so a venture still on the
 *  bonding curve has no DEX Screener presence at all — that is "not listed",
 *  not "unpaid". Pre- and post-graduation populations are structurally
 *  distinct (arXiv 2609.18975); collapsing them would label every honest
 *  raise as having skipped a payment it cannot yet make. */

const API = "https://api.dexscreener.com";

/** DEX Screener's chain slug. Verified against their live index: Robinhood
 *  Chain is `robinhood`. Blank env means "use the verified default" rather
 *  than "disable": every flavour this module serves is on that chain, and a
 *  blank slug is how the env read before the chain was indexed. */
const configured = String(import.meta.env.VITE_DEXSCREENER_CHAIN ?? "").trim();
export const DEX_CHAIN = configured || "robinhood";

export interface DexOrder {
  type: string;
  status: string;
  paymentTimestamp?: number;
}

export interface DexInfo {
  imageUrl?: string;
  header?: string;
  openGraph?: string;
  websites?: { url: string; label?: string }[];
  socials?: { url: string; type: string }[];
}

export interface DexPair {
  chainId?: string;
  dexId?: string;
  url?: string;
  pairAddress?: string;
  baseToken?: { address?: string };
  quoteToken?: { address?: string };
  liquidity?: { usd?: number };
  info?: DexInfo;
}

export type DexProfileState = "paid" | "pending" | "unpaid" | "unlisted" | "unknown";

export interface DexProfile {
  state: DexProfileState;
  /** What decided the state, so the UI can be honest about its evidence. */
  via: "order" | "profile-data" | "listing" | "none";
  /** Unix millis of the profile payment, when the order feed exposes it. */
  paidAt: number | null;
  /** The CMS payload the payment unlocks: logo, banner, links. */
  info: DexInfo | null;
  /** DEX Screener page for the deepest pool — where a trader would land. */
  url: string | null;
  pairs: number;
}

/** The Enhanced Token Info product, as the order feed names it. */
const PROFILE_ORDER = "tokenProfile";

/** Order statuses that mean no profile was bought. Observed live: an
 *  `approved` tokenProfile alongside a `cancelled` communityTakeover on the
 *  same token — a cancelled order of any type must not read as payment. */
const DEAD_STATUS = new Set(["cancelled", "canceled", "rejected", "expired", "refunded", "failed"]);

export const UNKNOWN: DexProfile = { state: "unknown", via: "none", paidAt: null, info: null, url: null, pairs: 0 };

/** True when DEX Screener is actually holding profile content for the token.
 *  `openGraph` is excluded deliberately: that URL is templated per token
 *  whether or not anyone paid, so counting it would mark everything paid. */
export function hasProfileData(info: DexInfo | undefined | null): boolean {
  if (!info) return false;
  return Boolean(
    info.header ||
    info.imageUrl ||
    (info.websites && info.websites.length > 0) ||
    (info.socials && info.socials.length > 0),
  );
}

/** Pure state machine over the two payloads. Either may be missing: the board
 *  has pairs but no orders, and a token can have an order before a pair.
 *
 *  `pairsTruncated` is how a bulk read admits it cannot tell "this token has
 *  no pool" from "this token's pools did not fit in the response". Without it
 *  a starved token reads as `unlisted`, which is a silent false negative. */
export function classifyDexProfile(orders: DexOrder[], pairs: DexPair[], pairsTruncated = false): DexProfile {
  // The deepest pool is the page worth linking; `info` is identical across a
  // token's pairs, but liquidity is not.
  const best = pairs.length
    ? pairs.reduce((a, b) => ((b.liquidity?.usd ?? 0) > (a.liquidity?.usd ?? 0) ? b : a))
    : null;
  const info = hasProfileData(best?.info) ? (best!.info as DexInfo) : null;
  const url = best?.url ?? null;
  const n = pairs.length;

  const profileOrders = orders.filter((o) => o.type === PROFILE_ORDER);
  const approved = profileOrders.filter((o) => o.status === "approved");
  const inflight = profileOrders.filter((o) => o.status !== "approved" && !DEAD_STATUS.has(o.status));

  if (approved.length > 0) {
    const stamps = approved.map((o) => o.paymentTimestamp ?? 0).filter((t) => t > 0);
    return { state: "paid", via: "order", paidAt: stamps.length ? Math.max(...stamps) : null, info, url, pairs: n };
  }
  // A banner and socials only reach DEX Screener's CMS through a paid
  // profile, so holding that content is itself the payment record — and it is
  // the only signal the bulk endpoint returns.
  if (info) return { state: "paid", via: "profile-data", paidAt: null, info, url, pairs: n };
  if (inflight.length > 0) return { state: "pending", via: "order", paidAt: null, info: null, url, pairs: n };
  if (n > 0) return { state: "unpaid", via: "listing", paidAt: null, info: null, url, pairs: n };
  if (pairsTruncated) return UNKNOWN;
  return { state: "unlisted", via: "none", paidAt: null, info: null, url: null, pairs: 0 };
}

/** Social links DEX Screener holds, mapped onto the labels this site uses, so
 *  a paid profile can fill gaps the founder left blank on-chain. */
export function profileLinks(info: DexInfo | null): { label: string; url: string }[] {
  if (!info) return [];
  const out: { label: string; url: string }[] = [];
  const seen = new Set<string>();
  const push = (label: string, url?: string) => {
    if (!url || !/^https?:\/\//i.test(url)) return;
    const key = url.toLowerCase().replace(/\/+$/, "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ label, url });
  };
  for (const w of info.websites ?? []) push(w.label?.trim() || "Website", w.url);
  for (const s of info.socials ?? []) {
    const t = (s.type || "").toLowerCase();
    push(t === "twitter" ? "X" : t ? t[0].toUpperCase() + t.slice(1) : "Link", s.url);
  }
  return out;
}

/* ------------------------------------------------------------------ cache */

interface Entry { profile: DexProfile; at: number; authoritative: boolean }

const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<DexProfile>>();

/** A paid profile does not change minute to minute; a missing one might have
 *  just been bought, and a failed fetch should be retried sooner than either. */
const TTL_MS = { paid: 15 * 60_000, other: 5 * 60_000, unknown: 45_000 } as const;

const ttlFor = (p: DexProfile): number =>
  p.state === "paid" ? TTL_MS.paid : p.state === "unknown" ? TTL_MS.unknown : TTL_MS.other;

const key = (token: string): string => token.toLowerCase();

function fresh(token: string, needAuthoritative: boolean): DexProfile | null {
  const e = cache.get(key(token));
  if (!e) return null;
  if (needAuthoritative && !e.authoritative) return null;
  if (Date.now() - e.at > ttlFor(e.profile)) return null;
  return e.profile;
}

function store(token: string, profile: DexProfile, authoritative: boolean): void {
  const k = key(token);
  const prev = cache.get(k);
  // Never let a bulk read overwrite the order-feed answer while it is fresh.
  if (prev?.authoritative && !authoritative && Date.now() - prev.at <= ttlFor(prev.profile)) return;
  cache.set(k, { profile, at: Date.now(), authoritative });
}

/** Exposed for tests and for a manual refresh after a user buys a profile. */
export function clearDexCache(): void {
  cache.clear();
  inflight.clear();
}

/* ------------------------------------------------------------------ fetch */

async function json(path: string): Promise<unknown> {
  const res = await fetch(`${API}${path}`, { headers: { accept: "application/json" } });
  if (!res.ok) throw new Error(`dexscreener ${res.status}`);
  return res.json();
}

const asArray = <T,>(v: unknown): T[] => (Array.isArray(v) ? (v as T[]) : []);

/** Authoritative single-token read: the order feed plus the pairs. One token
 *  page is one call to each, and the orders endpoint is the rate-limited one
 *  (60/min), which is why the board never touches it. */
export async function fetchDexProfile(token: Address | string): Promise<DexProfile> {
  const hit = fresh(token, true);
  if (hit) return hit;
  const k = key(token);
  const running = inflight.get(k);
  if (running) return running;

  const run = (async (): Promise<DexProfile> => {
    const [orders, pairs] = await Promise.all([
      json(`/orders/v1/${DEX_CHAIN}/${token}`).then((d) => {
        // The feed answers either a bare array or { orders: [...] }.
        const o = d as { orders?: unknown };
        return asArray<DexOrder>(Array.isArray(d) ? d : o?.orders);
      }).catch(() => null),
      json(`/latest/dex/tokens/${token}`).then((d) => asArray<DexPair>((d as { pairs?: unknown })?.pairs)).catch(() => null),
    ]);
    // Both legs down is genuinely unknown; one leg down still classifies, as
    // an order without a pair is "pending" and a pair without the feed falls
    // back to profile content.
    if (orders === null && pairs === null) return UNKNOWN;
    return classifyDexProfile(orders ?? [], pairs ?? []);
  })()
    .then((p) => { store(token, p, p.state !== "unknown"); return p; })
    .catch(() => UNKNOWN)
    .finally(() => { inflight.delete(k); });

  inflight.set(k, run);
  return run;
}

/** DEX Screener accepts many comma-separated addresses per call but caps the
 *  RESPONSE at 30 pairs in total, not 30 per token. Measured live: asking for
 *  three tokens returned 30 pairs of which one token owned all 30, starving
 *  the other two. So the batch stays small, and a starved token is reported
 *  `unknown` rather than `unlisted`. */
const BATCH = 5;
const PAIR_CAP = 30;

/** One bulk call: classify every address in `chunk` from the pairs returned.
 *  Tokens starved by the 30-pair response cap come back `unknown`. */
async function resolveChunk(chunk: string[]): Promise<Map<string, DexProfile>> {
  const out = new Map<string, DexProfile>();
  let pairs: DexPair[] | null = null;
  try {
    pairs = asArray<DexPair>(((await json(`/latest/dex/tokens/${chunk.join(",")}`)) as { pairs?: unknown })?.pairs);
  } catch {
    pairs = null;
  }
  if (pairs === null) {
    for (const t of chunk) out.set(t, UNKNOWN);
    return out;
  }
  // The response mixes every requested token's pairs together, and a token can
  // appear as either leg of a pair, so group by both sides.
  const byToken = new Map<string, DexPair[]>();
  for (const p of pairs) {
    for (const side of [p.baseToken?.address, p.quoteToken?.address]) {
      if (!side) continue;
      const k = side.toLowerCase();
      if (!chunk.includes(k)) continue;
      const list = byToken.get(k);
      if (list) list.push(p);
      else byToken.set(k, [p]);
    }
  }
  // At the cap the response is truncated, so an empty result for a token is
  // not evidence that the token has no pool.
  const truncated = chunk.length > 1 && pairs.length >= PAIR_CAP;
  for (const t of chunk) {
    const profile = classifyDexProfile([], byToken.get(t) ?? [], truncated);
    if (profile.state !== "unknown") store(t, profile, false);
    out.set(t, profile);
  }
  return out;
}

/** Bulk read for the board: pairs only, so a page of cards costs a handful of
 *  calls rather than one per token, and never touches the rate-limited order
 *  feed. Tokens crowded out of a saturated batch are re-read one at a time,
 *  where the 30-pair cap cannot starve them — one pair is all the classifier
 *  needs. */
export async function fetchDexProfiles(tokens: (Address | string)[]): Promise<Map<string, DexProfile>> {
  const out = new Map<string, DexProfile>();
  const missing: string[] = [];
  for (const t of tokens) {
    const hit = fresh(t, false);
    if (hit) out.set(key(t), hit);
    else if (!missing.includes(key(t))) missing.push(key(t));
  }
  if (missing.length === 0) return out;

  const starved: string[] = [];
  for (let i = 0; i < missing.length; i += BATCH) {
    const batch = await resolveChunk(missing.slice(i, i + BATCH));
    for (const [t, profile] of batch) {
      out.set(t, profile);
      if (profile.state === "unknown") starved.push(t);
    }
  }
  // Second pass, one address per call: a single token's pairs always fit.
  for (const t of starved) {
    const single = await resolveChunk([t]);
    const profile = single.get(t);
    if (profile) out.set(t, profile);
  }
  return out;
}

/* ------------------------------------------------------------------- hooks */

/** Authoritative profile for one token. Returns `unknown` until it resolves,
 *  which renders as nothing rather than as a wrong answer. */
export function useDexProfile(token: Address | string | undefined): DexProfile {
  const [profile, setProfile] = useState<DexProfile>(() => (token ? fresh(token, true) ?? UNKNOWN : UNKNOWN));
  useEffect(() => {
    if (!token) return;
    let live = true;
    fetchDexProfile(token).then((p) => { if (live) setProfile(p); });
    return () => { live = false; };
  }, [token]);
  return profile;
}

/** Bulk profiles for a list of tokens, keyed by lowercase address. */
export function useDexProfiles(tokens: (Address | string)[]): Map<string, DexProfile> {
  const ids = tokens.map((t) => key(t)).sort().join(",");
  const [map, setMap] = useState<Map<string, DexProfile>>(() => new Map());
  useEffect(() => {
    if (!ids) return;
    let live = true;
    fetchDexProfiles(ids.split(",")).then((m) => { if (live) setMap(m); });
    return () => { live = false; };
  }, [ids]);
  return map;
}

/** Just the canonical DEX Screener page for a token, resolved from their own
 *  pair data. Uses the pairs endpoint only — a link needs no order record,
 *  and the order feed is the rate-limited one. Null until it resolves, and
 *  null when the token has no pair, which callers render as a fallback link
 *  rather than a broken one. */
export function useDexPairUrl(token: Address | string | undefined): string | null {
  const profiles = useDexProfiles(token ? [token] : []);
  return (token ? profiles.get(key(token))?.url : null) ?? null;
}
