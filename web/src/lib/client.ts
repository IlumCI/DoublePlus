import { createPublicClient, fallback, http, type PublicClient } from "viem";
import type { LaunchpadClient } from "@launchpad/sdk";

import { chain, env } from "./env";
import { V4Client, type V4Addresses } from "./v4/client";

/** Deployed Quiver V4 launchpad on Robinhood Chain (immutable). */
const V4: V4Addresses = {
  factory: "0x548a942b6bc50944Ca7F147eA9aAE94AFd4a4663",
  hook: "0x08A27f842C32B9246B68a76734D60eeBc4d38044",
  router: "0x379ADE181d8e1dE59e5FDAeb46B0492ce4BbaC9f",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
};

const V4_START_BLOCK = 11248000n;

// One or more RPC endpoints (comma-separated in VITE_RPC_URL). Each is retried
// on transient failures (429 rate-limits, 5xx) with backoff, and viem's
// fallback rotates to the next endpoint if one keeps failing — so a single
// overloaded RPC under heavy traffic degrades gracefully instead of blanking
// the app. Adding a backup RPC is a pure env change, no code.
const rpcUrls = env.rpcUrl
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const publicClient = createPublicClient({
  chain,
  transport: fallback(
    rpcUrls.map((url) => http(url, { retryCount: 3, retryDelay: 200, batch: { wait: 16 } })),
  ),
  // Slow the live event watchers from viem's 4s default to 10s. Every open
  // market and the launch feed is watched per visitor, so at scale this is the
  // dominant RPC cost; 10s keeps trades feeling live while cutting that load
  // ~60%. Reads coalesce into Multicall3 within a 24ms window.
  pollingInterval: 10_000,
  batch: { multicall: { wait: 24 } },
}) as PublicClient;

const v4 = new V4Client(publicClient, V4, V4_START_BLOCK);

/**
 * In production, route the heavy bulk reads (token list, single token, trades,
 * candles) through our edge-cached serverless API instead of hitting the RPC
 * from every visitor's browser. Vercel serves these from its CDN, so the chain
 * is read at most once per short cache window no matter how many people are on
 * the site — turning O(users) RPC load into O(1). Any API hiccup transparently
 * falls back to reading straight from the chain, and live event watchers still
 * stream updates over RPC as before. Disabled in dev, where there is no /api.
 */
if (import.meta.env.PROD) {
  const apiGet = async <T>(path: string): Promise<T> => {
    const r = await fetch(`/api${path}`);
    if (!r.ok) throw new Error(`api ${r.status}`);
    return (await r.json()) as T;
  };
  const withApi = <A extends unknown[], R>(
    path: (...args: A) => string,
    rpc: (...args: A) => Promise<R>,
  ) => async (...args: A): Promise<R> => {
    try {
      return await apiGet<R>(path(...args));
    } catch {
      return rpc(...args);
    }
  };
  const q = (v: unknown) => encodeURIComponent(String(v));
  const orig = {
    getTokens: v4.getTokens.bind(v4),
    getToken: v4.getToken.bind(v4),
    getTrades: v4.getTrades.bind(v4),
    getCandles: v4.getCandles.bind(v4),
  };
  v4.getTokens = withApi(
    (opts?: { sort?: string; limit?: number }) => `/tokens?sort=${q(opts?.sort ?? "new")}&limit=${q(opts?.limit ?? 60)}`,
    orig.getTokens,
  ) as typeof v4.getTokens;
  v4.getToken = withApi((token: string) => `/token?address=${q(token)}`, orig.getToken) as typeof v4.getToken;
  v4.getTrades = withApi(
    (token: string, opts?: { limit?: number }) => `/trades?token=${q(token)}&limit=${q(opts?.limit ?? 50)}`,
    orig.getTrades,
  ) as typeof v4.getTrades;
  v4.getCandles = withApi(
    (token: string, interval: string, opts?: { limit?: number }) =>
      `/candles?token=${q(token)}&interval=${q(interval)}&limit=${q(opts?.limit ?? 500)}`,
    orig.getCandles,
  ) as typeof v4.getCandles;
}

/**
 * App-wide client singleton. It is the V4 launchpad client, cast to the v3
 * SDK's client type so the existing React hooks and pages consume it unchanged.
 */
export const client = v4 as unknown as LaunchpadClient;

/** Typed access to V4-only methods (dividends, stock, mcap scale). */
export const v4Client = v4;
