import { createPublicClient, fallback, http, parseAbiItem, type Address, type PublicClient } from "viem";

import { chain, env } from "../lib/env";

/** VentureFactory deployment. Defaults target the Robinhood Chain testnet
 *  (46630) deployment; every address is overridable via env so the same build
 *  serves mainnet (4663) with a pure env change. */
export const VENTURE = {
  factory: (import.meta.env.VITE_VENTURE_FACTORY ?? "0x0000000000000000000000000000000000000000") as Address,
  tokenDeployer: (import.meta.env.VITE_VENTURE_TOKEN_DEPLOYER ?? "0x0000000000000000000000000000000000000000") as Address,
  hook: (import.meta.env.VITE_VENTURE_HOOK ?? "0x0000000000000000000000000000000000000000") as Address,
  router: (import.meta.env.VITE_VENTURE_ROUTER ?? "0x0000000000000000000000000000000000000000") as Address,
  weth: (import.meta.env.VITE_WETH_ADDRESS ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73") as Address,
  startBlock: BigInt(String(import.meta.env.VITE_VENTURE_START_BLOCK ?? "0")),
  /** ETH/USD 8dp fallback for chains whose explorer can't price ETH (testnet).
   *  The curve sizes its $3k start FDV from this when live pricing fails. */
  ethUsd8Fallback: BigInt(String(import.meta.env.VITE_ETH_USD_8_FALLBACK ?? "0")),
  /** Protocol fee charged on every trade, mirrors the hook's immutable value. */
  platformFeeBps: Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? 100),
};

export const TOTAL_SUPPLY = 1_000_000_000;
export const CURVE_SUPPLY = 600_000_000; // whole tokens sold on the curve

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
    name: "curveState",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "deadline", type: "uint64" },
      { name: "price", type: "uint128" },
      { name: "soldWhole", type: "uint256" },
      { name: "remainingWhole", type: "uint256" },
      { name: "raisedWei", type: "uint256" },
      { name: "targetRaiseWei", type: "uint256" },
      { name: "finalized", type: "bool" },
      { name: "aborted", type: "bool" },
    ],
  },
  {
    type: "function",
    name: "terms",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "founderRaiseBps", type: "uint16" },
      { name: "maxBuyWei", type: "uint256" },
      { name: "vesting", type: "address" },
      { name: "basePriceWei", type: "uint128" },
      { name: "slopeQ", type: "uint128" },
    ],
  },
  { type: "function", name: "priceNow", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint128" }] },
  {
    type: "function",
    name: "feePolicyOf",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "devWallet", type: "address" },
      { name: "buyTaxBps", type: "uint16" },
      { name: "sellTaxBps", type: "uint16" },
      { name: "devBps", type: "uint16" },
      { name: "dividendBps", type: "uint16" },
      { name: "liquidityBps", type: "uint16" },
      { name: "mmBps", type: "uint16" },
    ],
  },
  { type: "function", name: "tokensForValue", stateMutability: "view", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "spentWei", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "boughtTokens", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "finalize", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "bytes32" }] },
  { type: "function", name: "abort", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
  { type: "function", name: "refund", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
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
          { name: "buyTaxBps", type: "uint16" },
          { name: "sellTaxBps", type: "uint16" },
          { name: "devWallet", type: "address" },
          { name: "devBps", type: "uint16" },
          { name: "dividendBps", type: "uint16" },
          { name: "liquidityBps", type: "uint16" },
          { name: "mmBps", type: "uint16" },
          { name: "ethUsdPrice8", type: "uint256" },
          { name: "targetRaiseWei", type: "uint256" },
          { name: "raiseDurationSecs", type: "uint64" },
          { name: "maxBuyWei", type: "uint256" },
          { name: "founderRaiseBps", type: "uint16" },
          { name: "founderSupplyBps", type: "uint16" },
          { name: "vestingSecs", type: "uint32" },
          { name: "v3Path", type: "bytes" },
        ],
      },
      { name: "salt", type: "bytes32" },
    ],
    outputs: [{ name: "token", type: "address" }],
  },
] as const;

export const vestingAbi = [
  { type: "function", name: "beneficiary", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "duration", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "startTime", stateMutability: "view", inputs: [], outputs: [{ type: "uint64" }] },
  { type: "function", name: "totalAllocation", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "released", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimable", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claim", stateMutability: "nonpayable", inputs: [], outputs: [{ type: "uint256" }] },
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
  "event CurveBuy(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint128 priceWei)",
);

const rpcUrls = env.rpcUrl.split(",").map((u) => u.trim()).filter(Boolean);
export const venturePc = createPublicClient({
  chain,
  transport: fallback(rpcUrls.map((url) => http(url, { retryCount: 1, retryDelay: 150, timeout: 6_000, batch: { wait: 16 } }))),
  pollingInterval: 8_000,
  batch: { multicall: { wait: 24 } },
}) as PublicClient;

export interface VentureMeta {
  description?: string;
  pitch?: string;
  sector?: string;
  logo?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
}

export type Phase = "raising" | "expired" | "graduated" | "failed";

export interface Venture {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  pair: Address;
  taxBps: number;
  createdAt: number;
  poolId: string;
  meta: VentureMeta;
  deadline: number;
  priceWei: bigint;
  soldWhole: bigint;
  remainingWhole: bigint;
  raisedWei: bigint;
  targetRaiseWei: bigint;
  finalized: boolean;
  aborted: boolean;
  founderRaiseBps: number;
  maxBuyWei: bigint;
  vesting: Address;
  policy: {
    devWallet: Address;
    buyTaxBps: number;
    sellTaxBps: number;
    devBps: number;
    dividendBps: number;
    liquidityBps: number;
    mmBps: number;
  };
  basePriceWei: bigint;
  slopeQ: bigint;
  phase: Phase;
}

function phaseOf(v: { finalized: boolean; aborted: boolean; deadline: number; raisedWei: bigint; targetRaiseWei: bigint; remainingWhole: bigint }): Phase {
  if (v.finalized) return "graduated";
  if (v.aborted) return "failed";
  const now = Math.floor(Date.now() / 1000);
  const targetHit = v.raisedWei >= v.targetRaiseWei || v.remainingWhole === 0n;
  if (targetHit) return "expired"; // fully funded, awaiting the graduation call
  if (now >= v.deadline) return "failed"; // past deadline below target (abort pending or done)
  return "raising";
}

export async function loadVentures(): Promise<Venture[]> {
  const total = Number(
    await venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "totalTokens" }),
  );
  const out: Venture[] = [];
  for (let i = total - 1; i >= 0; i--) {
    const address = (await venturePc.readContract({
      address: VENTURE.factory, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)],
    })) as Address;
    try {
      out.push(await loadVenture(address));
    } catch {
      /* skip one that can't be read this pass */
    }
  }
  return out;
}

export async function loadVenture(address: Address): Promise<Venture> {
  const [listing, curve, terms, policyRaw, name, symbol, metaRaw] = await Promise.all([
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "listings", args: [address] }),
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "curveState", args: [address] }),
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "terms", args: [address] }),
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "feePolicyOf", args: [address] }),
    venturePc.readContract({ address, abi: ercAbi, functionName: "name" }),
    venturePc.readContract({ address, abi: ercAbi, functionName: "symbol" }),
    venturePc.readContract({ address, abi: ercAbi, functionName: "metadataURI" }).catch(() => ""),
  ]);
  const [creator, pair, taxBps, createdAt, poolId] = listing as unknown as [Address, Address, number, bigint, string];
  const c = curve as unknown as [bigint, bigint, bigint, bigint, bigint, bigint, boolean, boolean];
  const t = terms as unknown as [number, bigint, Address, bigint, bigint];
  const pol = policyRaw as unknown as [Address, number, number, number, number, number, number];
  let meta: VentureMeta = {};
  try {
    meta = JSON.parse(String(metaRaw));
  } catch {
    /* plain string metadata */
  }
  const base = {
    finalized: c[6],
    aborted: c[7],
    deadline: Number(c[0]),
    raisedWei: c[4],
    targetRaiseWei: c[5],
    remainingWhole: c[3],
  };
  return {
    address,
    name: String(name),
    symbol: String(symbol),
    creator,
    pair,
    taxBps: Number(taxBps),
    createdAt: Number(createdAt),
    poolId: String(poolId),
    meta,
    deadline: base.deadline,
    priceWei: c[1],
    soldWhole: c[2],
    remainingWhole: c[3],
    raisedWei: c[4],
    targetRaiseWei: c[5],
    finalized: c[6],
    aborted: c[7],
    founderRaiseBps: Number(t[0]),
    maxBuyWei: t[1],
    vesting: t[2],
    policy: {
      devWallet: pol[0],
      buyTaxBps: Number(pol[1]),
      sellTaxBps: Number(pol[2]),
      devBps: Number(pol[3]),
      dividendBps: Number(pol[4]),
      liquidityBps: Number(pol[5]),
      mmBps: Number(pol[6]),
    },
    basePriceWei: t[3],
    slopeQ: t[4],
    phase: phaseOf(base),
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
  const latest = await venturePc.getBlockNumber();
  const logs = await venturePc.getLogs({
    address: VENTURE.factory, event: boughtEvent, args: { token }, fromBlock: VENTURE.startBlock, toBlock: latest,
  });
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

/** Client-side mirror of the on-chain integral pricing, for instant quotes
 *  between polls. cost(q) = q*p0 + k*(2Sq + q^2)/2e18, all in whole tokens. */
export function quoteTokens(v: Venture, valueWei: bigint): bigint {
  const k = v.slopeQ;
  if (valueWei <= 0n) return 0n;
  if (k === 0n) return v.basePriceWei > 0n ? valueWei / v.basePriceWei : 0n;
  const b = 10n ** 18n * v.basePriceWei + k * v.soldWhole;
  const disc = b * b + 2n * k * 10n ** 18n * valueWei;
  const q = (sqrtBig(disc) - b) / k;
  return q > v.remainingWhole ? v.remainingWhole : q;
}

function sqrtBig(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + n / x) / 2n; }
  return x;
}
