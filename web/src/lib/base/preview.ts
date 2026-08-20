import type { TokenSummary } from "@launchpad/sdk";

import { BASE_STOCKS } from "./stocks";
import { BASE_USDC, BASE_WETH } from "./routes";

/** True when design-preview fixtures may stand in for empty live data. */
export const PREVIEW_ON = String(import.meta.env.VITE_PREVIEW ?? "") === "1";

const mk = (name: string, symbol: string, reward: string, mcap: number, price: number, chg: number, vol: number, age: number): TokenSummary =>
  ({
    address: `0x${symbol.toLowerCase()}${"0".repeat(38)}`.slice(0, 42),
    name, symbol,
    creator: `0x${(name.length * 7).toString(16).padStart(2, "0")}beef00000000000000000000000000000000`.slice(0, 42),
    marketCapUsd: String(mcap), priceUsd: String(price), priceChange24hPct: chg, txCount24h: Math.round(vol / 500),
    createdAt: Math.floor(Date.now() / 1000) - age,
    volume24hWei: String(BigInt(Math.round(vol)) * 10n ** 18n), volumeTotalWei: String(BigInt(Math.round(vol * 3)) * 10n ** 18n),
    liquidityWei: String(BigInt(Math.round(mcap / 2)) * 10n ** 18n), holderCount: Math.round(mcap / 220),
    metadata: { rewardStock: BASE_STOCKS.find((s) => s.symbol === reward)?.address ?? (reward === "ETH" ? BASE_WETH : BASE_USDC) },
  }) as unknown as TokenSummary;

/** Design-preview fixtures (only shown when VITE_PREVIEW=1 and live data is empty). */
export const PREVIEW: TokenSummary[] = [
  mk("pools still open, billa", "OPEN", "GOOGL", 24040, 0.0000241, 71.92, 28190, 7200),
  mk("Tsunami", "TSU", "ETH", 51200, 0.0000512, 41.0, 33800, 3600),
  mk("Koi King", "KOI", "NVDA", 88100, 0.0000881, 27.6, 44300, 90000),
  mk("sushicat", "SUSHI", "META", 234360, 0.000234, 19.34, 125440, 40000),
  mk("Goldfish Gang", "GOLD", "AAPL", 20800, 0.0000208, 15.9, 12400, 15000),
  mk("Onigiri", "ONGR", "COIN", 31790, 0.0000317, 12.42, 13980, 62000),
  mk("Meowshi", "MEOW", "MSTR", 28390, 0.0000283, 8.78, 9360, 26000),
  mk("Flamingo", "FLMGO", "USDC", 39180, 0.0000391, 5.2, 21000, 120000),
  mk("Pixel Pond", "POND", "QQQ", 11200, 0.0000112, 2.1, 5200, 200000),
  mk("Wave Rider", "WAVE", "SPY", 15400, 0.0000154, -4.3, 7700, 260000),
];
