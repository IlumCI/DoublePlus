import { createPublicClient, fallback, http, parseAbiItem, type Address, type PublicClient } from "viem";

import { chain, env } from "../lib/env";

/** HammrFactory deployment on Robinhood Chain (4663). */
export const HAMMR = {
  factory: (import.meta.env.VITE_HAMMR_FACTORY ?? "0x465C69BB3810830f4fcB634FAD8ed1f48702FF6e") as Address,
  hook: (import.meta.env.VITE_HAMMR_HOOK ?? "0xBcA2c8D9bF9b8f362809018f19AFC765F4afC044") as Address,
  router: (import.meta.env.VITE_HAMMR_ROUTER ?? "0x27542d09e0d343289b2B4dCCd60C76a3DC195b20") as Address,
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73" as Address,
  startBlock: BigInt(String(import.meta.env.VITE_HAMMR_START_BLOCK ?? "27287154")),
};

export const AUCTION_SUPPLY = 500_000_000; // whole tokens on the block
export const TOTAL_SUPPLY = 1_000_000_000;

export const factoryAbi = [
  { type: "function", name: "totalTokens", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "listings",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "pair", type: "address" },
      { name: "taxBps", type: "uint16" },
      { name: "createdAt", type: "uint64" },
      { name: "poolId", type: "bytes32" },
    ],
  },
  {
    type: "function",
    name: "auctionState",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "endTime", type: "uint64" },
      { name: "price", type: "uint128" },
      { name: "sold", type: "uint256" },
      { name: "remaining", type: "uint256" },
      { name: "raisedWei", type: "uint256" },
      { name: "finalized", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "auctions",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "startTime", type: "uint64" },
      { name: "endTime", type: "uint64" },
      { name: "floorPriceWei", type: "uint128" },
      { name: "startPriceWei", type: "uint128" },
      { name: "lastPriceWei", type: "uint128" },
      { name: "sold", type: "uint256" },
      { name: "raisedWei", type: "uint256" },
      { name: "finalized", type: "bool" },
      { name: "pairUsdPrice8", type: "uint256" },
    ],
  },
  { type: "function", name: "priceNow", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint128" }] },
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }] },
  {
    type: "function",
    name: "launch",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "p",
        type: "tuple",
        components: [
          { name: "name", type: "string" },
          { name: "symbol", type: "string" },
          { name: "metadataURI", type: "string" },
          { name: "pair", type: "address" },
          { name: "taxBps", type: "uint16" },
          { name: "pairUsdPrice8", type: "uint256" },
          { name: "ethUsdPrice8", type: "uint256" },
          { name: "v3Path", type: "bytes" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
] as const;

export const routerAbi = [
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }, { type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "sell", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }, { type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
] as const;

export const ercAbi = [
  { type: "function", name: "name", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "metadataURI", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
  { type: "function", name: "pendingRewards", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "totalRewardsDistributed", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export const boughtEvent = parseAbiItem(
  "event Bought(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint128 priceWei)",
);
export const launchedEvent = parseAbiItem(
  "event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, uint64 endTime)",
);

const rpcUrls = env.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
export const hammrPc = createPublicClient({
  chain,
  transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 1, retryDelay: 150, timeout: 6_000, batch: { wait: 16 } }))),
  pollingInterval: 8_000,
  batch: { multicall: { wait: 24 } },
}) as PublicClient;

export interface LotMeta {
  description?: string;
  logo?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export interface Lot {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  pair: Address;
  pairSymbol: string;
  taxBps: number;
  createdAt: number;
  poolId: string;
  meta: LotMeta;
  endTime: number;
  priceWei: bigint;
  startPriceWei: bigint;
  floorPriceWei: bigint;
  sold: bigint;
  remaining: bigint;
  raisedWei: bigint;
  finalized: boolean;
  live: boolean;
}

const pairSymCache = new Map<string, string>();

export async function loadLots(): Promise<Lot[]> {
  const total = Number(await hammrPc.readContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "totalTokens" }));
  const lots: Lot[] = [];
  for (let i = total - 1; i >= 0; i--) {
    const address = (await hammrPc.readContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] })) as Address;
    try {
      lots.push(await loadLot(address));
    } catch {
      /* skip broken lot */
    }
  }
  return lots;
}

export async function loadLot(address: Address): Promise<Lot> {
  const [listing, auction, name, symbol, metaRaw] = await Promise.all([
    hammrPc.readContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "listings", args: [address] }),
    hammrPc.readContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "auctions", args: [address] }),
    hammrPc.readContract({ address, abi: ercAbi, functionName: "name" }),
    hammrPc.readContract({ address, abi: ercAbi, functionName: "symbol" }),
    hammrPc.readContract({ address, abi: ercAbi, functionName: "metadataURI" }).catch(() => ""),
  ]);
  const [creator, pair, taxBps, createdAt, poolId] = listing as unknown as [Address, Address, number, bigint, string];
  const a = auction as unknown as [bigint, bigint, bigint, bigint, bigint, bigint, bigint, boolean, bigint];
  let priceWei = 0n;
  try {
    priceWei = (await hammrPc.readContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "priceNow", args: [address] })) as bigint;
  } catch {
    priceWei = a[2];
  }
  let meta: LotMeta = {};
  try {
    meta = JSON.parse(String(metaRaw));
  } catch {
    /* plain string metadata */
  }
  let pairSymbol = pairSymCache.get(pair.toLowerCase()) ?? "";
  if (!pairSymbol) {
    pairSymbol = pair.toLowerCase() === HAMMR.weth.toLowerCase()
      ? "ETH"
      : ((await hammrPc.readContract({ address: pair, abi: ercAbi, functionName: "symbol" }).catch(() => "PAIR")) as string);
    pairSymCache.set(pair.toLowerCase(), pairSymbol);
  }
  const endTime = Number(a[1]);
  const finalized = a[7];
  const sold = a[5];
  const remaining = BigInt(AUCTION_SUPPLY) * 10n ** 18n - sold;
  const now = Math.floor(Date.now() / 1000);
  return {
    address,
    name: String(name),
    symbol: String(symbol),
    creator,
    pair,
    pairSymbol,
    taxBps: Number(taxBps),
    createdAt: Number(createdAt),
    poolId: String(poolId),
    meta,
    endTime,
    priceWei,
    startPriceWei: a[3],
    floorPriceWei: a[2],
    sold,
    remaining,
    raisedWei: a[6],
    finalized,
    live: !finalized && now < endTime && remaining > 0n,
  };
}

export interface Fill {
  buyer: Address;
  ethIn: bigint;
  tokensOut: bigint;
  priceWei: bigint;
  txHash: string;
  blockNumber: number;
}

export async function loadFills(token: Address): Promise<Fill[]> {
  const latest = await hammrPc.getBlockNumber();
  const logs = await hammrPc.getLogs({ address: HAMMR.factory, event: boughtEvent, args: { token }, fromBlock: HAMMR.startBlock, toBlock: latest });
  return logs
    .map((l) => ({
      buyer: l.args.buyer as Address,
      ethIn: l.args.ethIn as bigint,
      tokensOut: l.args.tokensOut as bigint,
      priceWei: l.args.priceWei as bigint,
      txHash: l.transactionHash,
      blockNumber: Number(l.blockNumber),
    }))
    .reverse();
}

/** Interpolated live price between polls: linear decay client-side. */
export function livePrice(lot: Lot): bigint {
  if (!lot.live) return lot.finalized ? lot.priceWei : lot.floorPriceWei;
  const now = Date.now() / 1000;
  const start = lot.endTime - 3600;
  const t = Math.min(Math.max((now - start) / 3600, 0), 1);
  const span = Number(lot.startPriceWei - lot.floorPriceWei);
  return lot.startPriceWei - BigInt(Math.floor(span * t));
}
