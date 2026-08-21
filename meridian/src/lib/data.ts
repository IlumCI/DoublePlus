/* Deterministic demo data for the launchpad. A seeded PRNG keeps every render
   identical so the UI feels like a stable product, not a dice roll. */

export type ChainId = "robinhood" | "ethereum" | "base" | "monad";

export interface Chain {
  id: ChainId;
  name: string;
  short: string;
  color: string;
}

export type LaunchStatus = "new" | "live" | "graduated";

export interface LaunchToken {
  ticker: string;
  name: string;
  description: string;
  chain: ChainId;
  price: number;
  change24h: number;
  marketCap: number;
  liquidity: number;
  volume24h: number;
  progress: number; // % of the graduation cap
  status: LaunchStatus;
  fairLaunch: boolean;
  creator: string;
  createdAt: number;
  holders: number;
  color: string;
  series: number[];
  website?: string;
  twitter?: string;
  telegram?: string;
  contract: string;
}

export interface Trade {
  id: string;
  side: "buy" | "sell";
  amountUsd: number;
  tokens: number;
  wallet: string;
  ts: number;
}

export const CHAINS: Chain[] = [
  { id: "robinhood", name: "Robinhood Chain", short: "RH", color: "#22C55E" },
  { id: "ethereum", name: "Ethereum", short: "ETH", color: "#8A9BF5" },
  { id: "base", name: "Base", short: "BASE", color: "#4C7DF0" },
  { id: "monad", name: "Monad", short: "MON", color: "#8B6EF3" },
];

export function chainById(id: ChainId): Chain {
  return CHAINS.find((c) => c.id === id) ?? CHAINS[0];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function series(seed: number, n: number, start: number, drift: number, vol: number): number[] {
  const rnd = mulberry32(seed);
  const out: number[] = [];
  let v = start;
  for (let i = 0; i < n; i++) {
    v = Math.max(start * 0.35, v * (1 + drift + (rnd() - 0.5) * vol));
    out.push(v);
  }
  return out;
}

function addr(seed: number): string {
  const rnd = mulberry32(seed);
  const hex = "0123456789abcdef";
  let s = "0x";
  for (let i = 0; i < 40; i++) s += hex[Math.floor(rnd() * 16)];
  return s;
}

const HOUR = 3600 * 1000;
const NOW = Date.now();

interface Def {
  ticker: string;
  name: string;
  description: string;
  chain: ChainId;
  mcapK: number; // market cap in $K
  change: number;
  status: LaunchStatus;
  fair: boolean;
  ageH: number; // hours since launch
  seed: number;
  color: string;
  socials?: boolean;
}

const defs: Def[] = [
  { ticker: "NORTH", name: "North Star", description: "Community index of the strongest launches on Robinhood Chain, rebalanced on-chain every epoch.", chain: "robinhood", mcapK: 38.2, change: 12.4, status: "live", fair: true, ageH: 26, seed: 21, color: "#22C55E", socials: true },
  { ticker: "PULSE", name: "Pulse Protocol", description: "Real-time on-chain heartbeat oracle. Streams block-level activity metrics to any contract.", chain: "base", mcapK: 31.6, change: 8.1, status: "live", fair: true, ageH: 41, seed: 22, color: "#4C7DF0", socials: true },
  { ticker: "QUARTZ", name: "Quartz", description: "Hard-money store of value with a fixed supply and zero taxes. No team allocation.", chain: "ethereum", mcapK: 52.4, change: 3.6, status: "graduated", fair: true, ageH: 190, seed: 23, color: "#9BA6C9", socials: true },
  { ticker: "DRIFT", name: "Drift Labs", description: "Automated LP rebalancer for concentrated liquidity positions across launch pools.", chain: "monad", mcapK: 12.8, change: -4.2, status: "live", fair: false, ageH: 9, seed: 24, color: "#8B6EF3" },
  { ticker: "EMBER", name: "Ember", description: "Deflationary burn token — 1% of every trade is burned forever. Fully renounced.", chain: "robinhood", mcapK: 24.5, change: 31.7, status: "live", fair: true, ageH: 5, seed: 25, color: "#F59E0B", socials: true },
  { ticker: "LEDGE", name: "Ledgeline", description: "Perps-adjacent index that tracks the top ten launchpad graduates by volume.", chain: "ethereum", mcapK: 44.9, change: 5.9, status: "graduated", fair: false, ageH: 260, seed: 26, color: "#5FA8F5", socials: true },
  { ticker: "MOSS", name: "Moss", description: "Slow-growth community token. Anti-whale limits stay on until full graduation.", chain: "base", mcapK: 8.7, change: 2.2, status: "new", fair: true, ageH: 1.4, seed: 27, color: "#34D399" },
  { ticker: "VOLT", name: "Voltage", description: "Gaming utility token powering an on-chain arcade. Fees fund the prize pool.", chain: "monad", mcapK: 17.3, change: -8.8, status: "live", fair: false, ageH: 58, seed: 28, color: "#C9B44B" },
  { ticker: "HALO", name: "Halo Network", description: "Reputation ring for launch creators — stake to vouch, slash on rugs.", chain: "robinhood", mcapK: 29.1, change: 15.2, status: "live", fair: true, ageH: 14, seed: 29, color: "#E879F9", socials: true },
  { ticker: "ANCHOR", name: "Anchor", description: "Protocol-managed liquidity with published on-chain proofs every hour.", chain: "ethereum", mcapK: 49.8, change: 1.1, status: "graduated", fair: true, ageH: 340, seed: 30, color: "#60A5FA", socials: true },
  { ticker: "FERN", name: "Fern", description: "Regenerative treasury token. 2% of volume streams to public-goods funding.", chain: "base", mcapK: 6.2, change: 44.5, status: "new", fair: true, ageH: 0.6, seed: 31, color: "#4ADE80" },
  { ticker: "ONYX", name: "Onyx", description: "Dark-pool style batch auctions for large exits without price impact.", chain: "monad", mcapK: 21.7, change: -2.4, status: "live", fair: false, ageH: 96, seed: 32, color: "#94A3B8" },
];

const GRAD_CAP_K = 40; // $40K market cap graduates a token

export const TOKENS: LaunchToken[] = defs.map((d, i) => {
  const price = (d.mcapK * 1000) / 1e9;
  return {
    ticker: d.ticker,
    name: d.name,
    description: d.description,
    chain: d.chain,
    price,
    change24h: d.change,
    marketCap: d.mcapK * 1000,
    liquidity: d.mcapK * 1000 * (0.32 + (i % 4) * 0.06),
    volume24h: d.mcapK * 1000 * (0.4 + ((i * 7) % 10) * 0.18),
    progress: d.status === "graduated" ? 100 : Math.min(99, (d.mcapK / GRAD_CAP_K) * 100),
    status: d.status,
    fairLaunch: d.fair,
    creator: addr(d.seed * 3 + 1),
    createdAt: NOW - d.ageH * HOUR,
    holders: Math.floor(40 + d.mcapK * (14 + (i % 5) * 3)),
    color: d.color,
    series: series(d.seed, 48, price, d.change / 4800, 0.03),
    website: d.socials ? `https://${d.ticker.toLowerCase()}.xyz` : undefined,
    twitter: d.socials ? `@${d.ticker.toLowerCase()}` : undefined,
    telegram: d.socials ? `t.me/${d.ticker.toLowerCase()}` : undefined,
    contract: addr(d.seed * 7 + 5),
  };
});

export function tokenByTicker(ticker: string): LaunchToken | undefined {
  return TOKENS.find((t) => t.ticker.toLowerCase() === ticker.toLowerCase());
}

export function tradesFor(ticker: string): Trade[] {
  const t = tokenByTicker(ticker);
  if (!t) return [];
  const rnd = mulberry32(t.createdAt % 100000);
  const out: Trade[] = [];
  let ts = NOW - 2 * 60 * 1000;
  for (let i = 0; i < 14; i++) {
    const usd = 15 + rnd() * 900;
    out.push({
      id: `${ticker}-${i}`,
      side: rnd() > 0.42 ? "buy" : "sell",
      amountUsd: usd,
      tokens: usd / t.price,
      wallet: addr(i * 13 + 7),
      ts,
    });
    ts -= (2 + rnd() * 40) * 60 * 1000;
  }
  return out;
}

/* Platform statistics ------------------------------------------------------ */
export const STATS = {
  liveTokens: TOKENS.filter((t) => t.status !== "graduated").length + 133,
  totalVolume: 96.4e6,
  tokensCreated: 3481,
  volume24h: 2.94e6,
};

/* Demo portfolio ----------------------------------------------------------- */
export interface Position {
  ticker: string;
  amount: number; // token units
  costUsd: number;
}

export const POSITIONS: Position[] = [
  { ticker: "NORTH", amount: 5.4e6, costUsd: 148 },
  { ticker: "EMBER", amount: 12.1e6, costUsd: 210 },
  { ticker: "QUARTZ", amount: 2.2e6, costUsd: 96 },
  { ticker: "HALO", amount: 7.8e6, costUsd: 195 },
  { ticker: "FERN", amount: 30.5e6, costUsd: 120 },
];

export const CREATED_TICKERS = ["HALO", "FERN"];

export function positionValue(p: Position): number {
  const t = tokenByTicker(p.ticker);
  return t ? p.amount * t.price : 0;
}

export function portfolioValue(): number {
  return POSITIONS.reduce((sum, p) => sum + positionValue(p), 0);
}
