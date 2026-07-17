import { createPublicClient, defineChain, fallback, http, type PublicClient } from "viem";

import { V4Client, type V4Addresses } from "../src/lib/v4/client";

/**
 * Server-side singleton of the same pure-viem V4 reader the browser uses, run
 * once per serverless instance. Responses are edge-cached (see each handler's
 * Cache-Control), so many visitors are served from Vercel's CDN and the chain
 * is read at most once per cache window regardless of traffic — the O(users) →
 * O(1) win. Reusing the browser's reader keeps a single source of truth for how
 * on-chain data is shaped.
 */
const RPC_URLS = (process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com")
  .split(",")
  .map((u) => u.trim())
  .filter(Boolean);

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: RPC_URLS } },
  contracts: { multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});

const V4: V4Addresses = {
  factory: "0xd14C7f4daFE5517EF78289f1c055628Ab7c64663",
  hook: "0xd7978e0b3f1D39b0d42f47Eaf1147796aB9B8044",
  router: "0xB66c81023139768ca93236C271C5093Be1cAdeBA",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
};

const V4_START_BLOCK = 11942000n;

const publicClient = createPublicClient({
  chain,
  transport: fallback(RPC_URLS.map((url) => http(url, { retryCount: 3, retryDelay: 200, batch: { wait: 16 } }))),
  batch: { multicall: { wait: 24 } },
}) as PublicClient;

export const reader = new V4Client(publicClient, V4, V4_START_BLOCK);

/** JSON with BigInt values coerced to strings, so any stray bigint is safe. */
export function sendJson(res: any, data: unknown, sMaxAge: number, swr: number): void {
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", `public, s-maxage=${sMaxAge}, stale-while-revalidate=${swr}`);
  res.end(JSON.stringify(data, (_k, v) => (typeof v === "bigint" ? v.toString() : v)));
}

export function fail(res: any, err: unknown): void {
  res.statusCode = 500;
  res.setHeader("content-type", "application/json; charset=utf-8");
  // Never cache errors, so one blip doesn't get pinned at the edge.
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
}
