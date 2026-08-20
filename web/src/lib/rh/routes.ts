import { encodePacked, getAddress, type Address, type Hex, type PublicClient } from "viem";

import { stockOf } from "../v4/stocks";

// Canonical Robinhood-chain infra used to route the ETH<->pair leg.
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const V3_FACTORY = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA" as Address;
const WETH_USDG_FEE = 100; // deepest WETH/USDG V3 tier
const MEME_FEES = [10000, 3000, 500, 100] as const;

const v3FactoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;

export interface PairRoute {
  /** V3 path WETH -> ... -> pair (empty when the pair IS WETH). */
  buy: Hex;
  /** V3 path pair -> ... -> WETH. */
  sell: Hex;
}

const routeCache = new Map<string, PairRoute>();
const usdCache = new Map<string, { at: number; usd: number }>();
const EMPTY: Hex = "0x";

/** Resolve the V3 swap path for a coin's pair token, so the router can bridge
 *  ETH<->pair. Stocks route through USDG (WETH->USDG->stock); memes route
 *  directly through their WETH pool, or via USDG when only that exists. WETH
 *  pairs need no V3 leg. Cached per pair. */
export async function resolvePairRoute(pc: PublicClient, pairRaw: Address): Promise<PairRoute> {
  const pair = getAddress(pairRaw);
  const key = pair.toLowerCase();
  const hit = routeCache.get(key);
  if (hit) return hit;

  let route: PairRoute = { buy: EMPTY, sell: EMPTY };

  if (pair.toLowerCase() === WETH.toLowerCase()) {
    routeCache.set(key, route);
    return route;
  }

  // Curated stocks live in USDG pools; use the known fee tier.
  const stock = stockOf(pair);
  if (stock && stock.venue === "v3") {
    route = {
      buy: encodePacked(["address", "uint24", "address", "uint24", "address"], [WETH, WETH_USDG_FEE, USDG, stock.fee, pair]),
      sell: encodePacked(["address", "uint24", "address", "uint24", "address"], [pair, stock.fee, USDG, WETH_USDG_FEE, WETH]),
    };
    routeCache.set(key, route);
    return route;
  }

  // Meme (or v4-only stock): prefer a direct WETH pool, else route via USDG.
  const wethFee = await bestFee(pc, pair, WETH);
  if (wethFee) {
    route = {
      buy: encodePacked(["address", "uint24", "address"], [WETH, wethFee, pair]),
      sell: encodePacked(["address", "uint24", "address"], [pair, wethFee, WETH]),
    };
  } else {
    const usdgFee = await bestFee(pc, pair, USDG);
    if (usdgFee) {
      route = {
        buy: encodePacked(["address", "uint24", "address", "uint24", "address"], [WETH, WETH_USDG_FEE, USDG, usdgFee, pair]),
        sell: encodePacked(["address", "uint24", "address", "uint24", "address"], [pair, usdgFee, USDG, WETH_USDG_FEE, WETH]),
      };
    }
  }
  routeCache.set(key, route);
  return route;
}

/** First fee tier with a real pool for tokenA/tokenB on the canonical V3
 *  factory, or null if none exists. */
async function bestFee(pc: PublicClient, a: Address, b: Address): Promise<number | null> {
  for (const fee of MEME_FEES) {
    try {
      const pool = (await pc.readContract({
        address: V3_FACTORY,
        abi: v3FactoryAbi,
        functionName: "getPool",
        args: [a, b, fee],
      })) as Address;
      if (pool && pool !== "0x0000000000000000000000000000000000000000") return fee;
    } catch {
      /* try next tier */
    }
  }
  return null;
}

const v3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "observationIndex", type: "uint16" },
      { name: "observationCardinality", type: "uint16" },
      { name: "observationCardinalityNext", type: "uint16" },
      { name: "feeProtocol", type: "uint8" },
      { name: "unlocked", type: "bool" },
    ],
  },
] as const;

/** Live USD price of a pair token (stock or meme) from Blockscout, cached 60s.
 *  Small memes have no Blockscout exchange rate, so when a client is given we
 *  fall back to pricing through the token's V3 WETH pool (both 18 decimals):
 *  usd = WETH usd x WETH-per-token from slot0. Then a bundled stock snapshot,
 *  then 0. */
export async function pairUsd(pair: Address, pc?: PublicClient): Promise<number> {
  const key = pair.toLowerCase();
  const hit = usdCache.get(key);
  if (hit && Date.now() - hit.at < 60_000) return hit.usd;
  let usd = 0;
  try {
    const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${pair}`, {
      headers: { accept: "application/json" },
    });
    if (r.ok) {
      const j = await r.json();
      const v = Number(j?.exchange_rate);
      if (Number.isFinite(v) && v > 0) usd = v;
    }
  } catch {
    /* fall through */
  }
  // Same-origin relay next: phone carriers and bot walls sometimes block
  // direct browser fetches to blockscout, which zeroed every mcap on mobile.
  if (usd === 0 && typeof window !== "undefined") {
    try {
      const r = await fetch(`/api/usd?token=${pair}`);
      if (r.ok) {
        const v = Number((await r.json())?.usd);
        if (Number.isFinite(v) && v > 0) usd = v;
      }
    } catch {
      /* fall through */
    }
  }
  if (usd === 0) usd = stockOf(pair)?.usd ?? 0;
  // Last resort for the one token every price hangs off: a bundled ETH
  // snapshot beats rendering the whole board as $0.
  if (usd === 0 && key === WETH.toLowerCase()) usd = 1855;
  if (usd === 0 && pc && key !== WETH.toLowerCase()) {
    try {
      const wethUsd = await pairUsd(WETH);
      const fee = await bestFee(pc, pair, WETH);
      if (wethUsd > 0 && fee) {
        const pool = (await pc.readContract({
          address: V3_FACTORY,
          abi: v3FactoryAbi,
          functionName: "getPool",
          args: [pair, WETH, fee],
        })) as Address;
        const slot0 = await pc.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" });
        const sqrtP = slot0[0] as bigint;
        // price = token1 per 1 token0, both sides 18 decimals here.
        const p = (Number(sqrtP) / 2 ** 96) ** 2;
        if (p > 0) {
          const wethIs0 = WETH.toLowerCase() < key;
          const wethPerToken = wethIs0 ? 1 / p : p;
          usd = wethUsd * wethPerToken;
        }
      }
    } catch {
      /* keep 0 */
    }
  }
  usdCache.set(key, { at: Date.now(), usd });
  return usd;
}
