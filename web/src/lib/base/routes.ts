import { encodePacked, getAddress, type Address, type Hex } from "viem";

import { baseStockOf, BASE_STOCKS } from "./stocks";

// Base infra for the StockFlyRouter's ETH<->stock leg. The tokenized stocks
// hold their deep liquidity on Aerodrome Slipstream (concentrated liquidity),
// quoted in USDC, so the path hops WETH -> USDC -> stock. Slipstream paths
// encode each hop's int24 tickSpacing (not a uint24 fee).
export const BASE_WETH = "0x4200000000000000000000000000000000000006" as Address;
export const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as Address;
// WETH/USDC Slipstream tickSpacing (deep pool). Every stock/USDC Slipstream
// pool uses tickSpacing 10; a stock can override via its registry entry.
const WETH_USDC_TS = 1;
const DEFAULT_STOCK_TS = 10;

export interface PairRoute {
  /** Slipstream path WETH -> USDC -> stock (empty when the pair IS WETH). */
  buy: Hex;
  /** Slipstream path stock -> USDC -> WETH. */
  sell: Hex;
}

const EMPTY: Hex = "0x";
const routeCache = new Map<string, PairRoute>();

/** Slipstream exact-input path for a coin's stock pair, so StockFlyRouter can
 *  bridge ETH<->stock. WETH pairs (should not occur on Base stock launches)
 *  need no external leg. Cached per pair. */
export function resolveBaseRoute(pairRaw: Address): PairRoute {
  const pair = getAddress(pairRaw);
  const key = pair.toLowerCase();
  const hit = routeCache.get(key);
  if (hit) return hit;

  if (key === BASE_WETH.toLowerCase()) {
    const r = { buy: EMPTY, sell: EMPTY };
    routeCache.set(key, r);
    return r;
  }

  const ts = baseStockOf(pair)?.usdcTickSpacing ?? DEFAULT_STOCK_TS;
  const route: PairRoute = {
    buy: encodePacked(
      ["address", "int24", "address", "int24", "address"],
      [BASE_WETH, WETH_USDC_TS, BASE_USDC, ts, pair],
    ),
    sell: encodePacked(
      ["address", "int24", "address", "int24", "address"],
      [pair, ts, BASE_USDC, WETH_USDC_TS, BASE_WETH],
    ),
  };
  routeCache.set(key, route);
  return route;
}

// Snapshot USD prices for the board's market cap and the ETH-denominated trade
// quote. The stock snapshots come from the curated registry (they also size the
// launch); WETH is a rough snapshot, refined by trades once a coin has any.
const WETH_USD_SNAPSHOT = 1900;

/** USD price of a Base pair token (stock, WETH or USDC), from the curated
 *  snapshot. USDC is a dollar, so a coin paired to it prices without a stock
 *  entry — otherwise its market cap would read as zero. */
export function baseStockUsd(pair: Address): number {
  const p = pair.toLowerCase();
  if (p === BASE_WETH.toLowerCase()) return WETH_USD_SNAPSHOT;
  if (p === BASE_USDC.toLowerCase()) return 1;
  return baseStockOf(pair)?.usd ?? 0;
}

/** All Base stock addresses, for any allowlist checks. */
export const BASE_STOCK_ADDRESSES = new Set(BASE_STOCKS.map((s) => s.address.toLowerCase()));
