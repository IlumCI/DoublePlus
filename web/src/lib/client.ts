import { createPublicClient, fallback, http, type PublicClient } from "viem";
import type { LaunchpadClient } from "@launchpad/sdk";

import { addresses as envAddresses, chain, env } from "./env";
import { StableV3Client } from "./stable/client";
import { V4Client, type V4Addresses } from "./v4/client";
import { RhClient } from "./rh/client";

/**
 * Deployed Quiver V4 launchpad addresses. Defaults are the immutable
 * Robinhood Chain deployment; each is overridable via env so the same
 * codebase can target another chain's deployment (e.g. Steadypads on
 * Stable) with a pure env change.
 */
const addr = (key: string, fallback: `0x${string}`): `0x${string}` => {
  const v = import.meta.env[key];
  return (v ? String(v) : fallback) as `0x${string}`;
};

const V4: V4Addresses = {
  factory: addr("VITE_V4_FACTORY", "0x7684E116F10DD7B6634E17cba9A3767CD7B84663"),
  hook: addr("VITE_V4_HOOK", "0x1E8fd8f01C44084E514d872AD27455De5c994044"),
  router: addr("VITE_V4_ROUTER", "0xA5CED4a472586B79c8d744F1b50b8D5a703b1b5d"),
  poolManager: addr("VITE_V4_POOL_MANAGER", "0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  weth: addr("VITE_V4_WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: addr("VITE_V4_USDG", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
  // Official Uniswap V4 periphery StateView (same address on Robinhood and Arc).
  stateView: addr("VITE_V4_STATE_VIEW", "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
};

const V4_START_BLOCK = BigInt(String(import.meta.env.VITE_V4_START_BLOCK ?? "12744439"));

// One or more RPC endpoints (comma-separated in VITE_RPC_URL). Each is retried
// on transient failures (429 rate-limits, 5xx) with backoff, and viem's
// fallback rotates to the next endpoint if one keeps failing; so a single
// overloaded RPC under heavy traffic degrades gracefully instead of blanking
// the app. Adding a backup RPC is a pure env change, no code.
const rpcUrls = env.rpcUrl
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean)
  // A path entry (e.g. /api/rpc) is our same-origin relay; resolve it against
  // the site so phones blocked from the upstream RPC still get data.
  .map((u) => (u.startsWith("/") && typeof location !== "undefined" ? `${location.origin}${u}` : u));

const publicClient = createPublicClient({
  chain,
  // Short per-request timeout and periodic re-ranking: if a device cannot
  // reach one endpoint (carrier blocks, bot walls), the working one is
  // promoted to primary instead of every read re-paying the dead hop.
  transport: fallback(
    rpcUrls.map((url) => http(url, { retryCount: 1, retryDelay: 150, timeout: 6_000, batch: { wait: 16 } })),
    { rank: { interval: 30_000, sampleCount: 5 } },
  ),
  // Slow the live event watchers from viem's 4s default to 10s. Every open
  // market and the launch feed is watched per visitor, so at scale this is the
  // dominant RPC cost; 10s keeps trades feeling live while cutting that load
  // ~60%. Reads coalesce into Multicall3 within a 24ms window.
  pollingInterval: 10_000,
  batch: { multicall: { wait: 24 } },
}) as PublicClient;

/** Protocol switch: "stable-v3" targets StableLaunchpadFactory on Stable
 *  Mainnet (official Uniswap V3); anything else is the Quiver V4 launchpad. */
const IS_STABLE = String(import.meta.env.VITE_PROTOCOL ?? "") === "stable-v3";

/** "rh-v4": the Robinhood-chain pair=reward fork (RhFactory/RhHook/RhRouter),
 *  where a coin pairs against a chosen stock or meme and holders earn it. */
const IS_RH = String(import.meta.env.VITE_PROTOCOL ?? "") === "rh-v4";

const RH: V4Addresses = {
  factory: addr("VITE_RH_FACTORY", "0x44F0fEF21366e9a8FA7e594FAc0166eA63efd62c"),
  hook: addr("VITE_RH_HOOK", "0xa775543d7CFd79de8Cf5305A60f11c990099C044"),
  router: addr("VITE_RH_ROUTER", "0x7414F382cc855b318ad47B889c7eEEC1764d552F"),
  poolManager: addr("VITE_V4_POOL_MANAGER", "0x8366a39cc670b4001a1121b8f6a443a643e40951"),
  weth: addr("VITE_V4_WETH", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
  usdg: addr("VITE_V4_USDG", "0x5fc5360d0400a0fd4f2af552add042d716f1d168"),
  stateView: addr("VITE_V4_STATE_VIEW", "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b"),
};
const RH_START_BLOCK = BigInt(String(import.meta.env.VITE_RH_START_BLOCK ?? "34558420"));
// "base-stock": the Base StockFlyFactoryV2 model. Coins are native B-20 tokens
// that pair a creator-chosen tokenized stock and pay holders that stock through
// a per-coin reward vault (vs. the Robinhood fork's flat WETH pair).
const IS_BASE_STOCK = String(import.meta.env.VITE_LAUNCH_MODE ?? "") === "base-stock";
const rh = IS_RH ? new RhClient(publicClient, RH, RH_START_BLOCK, { baseStock: IS_BASE_STOCK }) : null;

const stable = IS_STABLE
  ? new StableV3Client(publicClient, {
      factory: envAddresses.factory,
      swapRouter: String(import.meta.env.VITE_SWAP_ROUTER ?? "") as `0x${string}`,
      quote: String(import.meta.env.VITE_QUOTE_ASSET ?? "") as `0x${string}`,
    })
  : null;

const v4 = new V4Client(publicClient, V4, V4_START_BLOCK);

/**
 * In production, route the heavy bulk reads (token list, single token, trades,
 * candles) through our edge-cached serverless API instead of hitting the RPC
 * from every visitor's browser. Vercel serves these from its CDN, so the chain
 * is read at most once per short cache window no matter how many people are on
 * the site; turning O(users) RPC load into O(1). Any API hiccup transparently
 * falls back to reading straight from the chain, and live event watchers still
 * stream updates over RPC as before. Disabled in dev, where there is no /api.
 */
if (import.meta.env.PROD && !IS_STABLE && !IS_RH) {
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
export const client = (stable ?? rh ?? v4) as unknown as LaunchpadClient;

/** Typed access to V4-only methods (dividends, stock, mcap scale). On the
 *  Stable protocol these degrade gracefully inside StableV3Client. */
export const v4Client = (stable ?? rh ?? v4) as unknown as V4Client;
