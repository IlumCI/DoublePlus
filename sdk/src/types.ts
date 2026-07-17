export type Address = `0x${string}`;

export type CandleInterval = "1m" | "5m" | "15m" | "30m" | "1h" | "4h" | "1d" | "1w";

export const CANDLE_INTERVALS: readonly CandleInterval[] = [
  "1m",
  "5m",
  "15m",
  "30m",
  "1h",
  "4h",
  "1d",
  "1w",
];

export const INTERVAL_SECONDS: Record<CandleInterval, number> = {
  "1m": 60,
  "5m": 300,
  "15m": 900,
  "30m": 1800,
  "1h": 3600,
  "4h": 14400,
  "1d": 86400,
  "1w": 604800,
};

/** OHLC candle. Prices are native currency per token as decimal strings. */
export interface Candle {
  /** Bucket start, unix seconds. */
  time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  /** Native currency volume in the bucket, decimal string (wei). */
  volume: string;
}

export interface TokenMetadata {
  description?: string;
  logo?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  links?: { label: string; url: string }[];
}

export interface TokenSummary {
  address: Address;
  name: string;
  symbol: string;
  creator: Address;
  pool: Address;
  feeTier: number;
  createdAt: number;
  featured: boolean;
  metadata: TokenMetadata;
  totalSupply: string;
  /** Latest price, native wei per whole token (1e18 units), decimal string. */
  priceWei: string;
  priceUsd: string;
  marketCapUsd: string;
  /** Native wei currently in the pool (both sides valued in native). */
  liquidityWei: string;
  volume24hWei: string;
  volumeTotalWei: string;
  txCount24h: number;
  holderCount: number;
  limitsActive: boolean;
  /** USD (8 decimals) remaining until limits lift. "0" when graduated. */
  remainingToGraduationUsd: string;
  priceChange24hPct: number | null;
  /** Lifetime trading fees paid to the creator, native wei. */
  creatorFeesWei?: string;
}

export interface TradeRecord {
  id: string;
  token: Address;
  trader: Address;
  isBuy: boolean;
  nativeAmountWei: string;
  tokenAmount: string;
  feeWei: string;
  priceWei: string;
  blockNumber: number;
  txHash: string;
  timestamp: number;
}

export interface HolderRecord {
  address: Address;
  balance: string;
  /** Percentage of total supply, e.g. 4.27 */
  pct: number;
}

export interface PoolInfo {
  pool: Address;
  feeTier: number;
  sqrtPriceX96: string;
  tick: number;
  poolLiquidity: string;
  positionTokenId: string;
  positionLiquidity: string;
}

export interface TradingLimits {
  active: boolean;
  maxTxAmount: string;
  maxWalletAmount: string;
  buyCooldownSeconds: number;
  marketCapUsd: string;
  remainingUsd: string;
  graduationCapUsd: string;
}

export interface PlatformStats {
  totalLaunches: number;
  totalVolumeWei: string;
  totalFeesWei: string;
  creatorPayoutsWei: string;
  platformRevenueWei: string;
  tokens24h: number;
  volume24hWei: string;
}

export interface CreatorStats {
  address: Address;
  tokensLaunched: number;
  totalVolumeWei: string;
  lifetimeEarnedWei: string;
  pendingWei: string;
  tokens: TokenSummary[];
}

/**
 * Launch parameters. Supply (1B), pool fee tier (0.3%), the 1% trading fee,
 * the starting market cap and the anti-whale limits (1% max transaction,
 * 2% max wallet until the 40,000 USD market cap) are fixed protocol rules.
 * Launching is free: the pool is seeded single-sided with the full supply
 * and needs no upfront liquidity.
 */
export interface CreateTokenParams {
  name: string;
  symbol: string;
  description?: string;
  logo?: string;
  website?: string;
  twitter?: string;
  telegram?: string;
  links?: { label: string; url: string }[];
  /** Optional first buy for the creator, in native wei, same transaction. */
  firstBuyWei?: bigint;
}

export interface LaunchpadAddresses {
  /** The LaunchpadFactory: launches, trades, fee accounting, held positions. */
  factory: Address;
  /** The TokenDeployer the factory mints tokens through. */
  tokenDeployer: Address;
  weth: Address;
}

export type PriceUpdate = {
  token: Address;
  priceWei: string;
  priceUsd: string;
  marketCapUsd: string;
  liquidityWei: string;
  limitsActive: boolean;
  remainingToGraduationUsd: string;
  /** Creator's currently-claimable fees, native wei. Updates live per trade. */
  creatorFeesWei: string;
};

export type CandleUpdate = {
  token: Address;
  interval: CandleInterval;
  candle: Candle;
};

export type WsServerMessage =
  | { channel: "trade:update"; token: Address; data: TradeRecord }
  | { channel: "price:update"; token: Address; data: PriceUpdate }
  | { channel: "candle:update"; token: Address; data: CandleUpdate }
  | { channel: "token:launched"; token: Address; data: TokenSummary }
  | { channel: "subscribed" | "unsubscribed"; token?: string; topic?: string }
  | { channel: "error"; message: string };
