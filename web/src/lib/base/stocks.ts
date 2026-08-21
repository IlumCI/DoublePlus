import type { Address } from "viem";

/** A Base tokenized stock usable as a launch pair + holder reward. These are
 *  the real tokenized equities/ETFs that exist on Base, across both issuers
 *  (the "c" issuer at 0xb2… and the "wt" wrapped issuer). `usd` is a snapshot
 *  price for sizing the launch and the board's market cap; `symbol` is the
 *  clean display ticker. */
export interface BaseStock {
  symbol: string;
  name: string;
  address: Address;
  usd: number;
  /** Aerodrome Slipstream tickSpacing of the stock's USDC pool, when it has one. */
  usdcTickSpacing: number;
}

/** Tokenized stocks available on Base, deepest first. Trading a launched coin
 *  goes through the coin's own pool, so a stock is listable regardless of its
 *  own external liquidity. */
export const BASE_STOCKS: BaseStock[] = [
  { symbol: "META", name: "Meta Platforms", address: "0xb2000000000000000000008bC8786B856E61707C", usd: 540.79, usdcTickSpacing: 10 },
  { symbol: "GOOGL", name: "Alphabet (Google)", address: "0xb2000000000000000000002D0BA3164cc74f58B7", usd: 342.47, usdcTickSpacing: 10 },
  { symbol: "AAPL", name: "Apple", address: "0xb200000000000000000000C2e324d24d7eEcd1fb", usd: 309.83, usdcTickSpacing: 10 },
  { symbol: "NVDA", name: "NVIDIA", address: "0xb20000000000000000000078ee7ce2fE4908108C", usd: 218.93, usdcTickSpacing: 10 },
  { symbol: "QQQ", name: "Nasdaq 100 ETF", address: "0x823FF7Bbde2869aAe73A6CD53e7f614442836757", usd: 296.52, usdcTickSpacing: 10 },
  { symbol: "AMZN", name: "Amazon", address: "0x997baE3EC193a249596d3708C3fAB7C501Bb8a53", usd: 263.23, usdcTickSpacing: 10 },
  { symbol: "COIN", name: "Coinbase", address: "0x5cDa0E1CA4ce2af96315f7F8963C85399c172204", usd: 146.92, usdcTickSpacing: 10 },
  { symbol: "MSTR", name: "MicroStrategy", address: "0xFF05E1bD696900dc6A52CA35Ca61Bb1024eDa8e2", usd: 93.95, usdcTickSpacing: 10 },
  { symbol: "SPY", name: "S&P 500 ETF", address: "0x31C2C14134e6E3B7ef9478297F199331133Fc2d8", usd: 90.88, usdcTickSpacing: 10 },
];

export const baseStockOf = (addr?: string): BaseStock | undefined =>
  addr ? BASE_STOCKS.find((s) => s.address.toLowerCase() === addr.toLowerCase()) : undefined;
