import type { Address, CandleInterval } from "@launchpad/sdk";

import { BRAND } from "./brand";

import { v4Client } from "./client";

/**
 * A TradingView Advanced Charts datafeed backed by our on-chain candles.
 * Bars are the token's market cap in USD (price × supply × native/USD), matching
 * the "Market cap" chart. One datafeed instance per token.
 */
const RES_TO_INTERVAL: Record<string, CandleInterval> = {
  "1": "1m", "5": "5m", "15": "15m", "30": "30m", "60": "1h", "240": "4h", "1D": "1d", "1W": "1w",
};
const RESOLUTIONS = ["1", "5", "15", "30", "60", "240", "1D", "1W"];

type Bar = { time: number; open: number; high: number; low: number; close: number; volume: number };

export function makeDatafeed(token: Address, symbol: string) {
  let scale = 1;
  const scaleReady = v4Client.mcapScale(token).then((s) => (scale = s || 1)).catch(() => 1);
  const subs = new Map<string, ReturnType<typeof setInterval>>();

  const toBar = (c: { time: number; open: string; high: string; low: string; close: string; volume: string }): Bar => ({
    time: c.time * 1000,
    open: Number(c.open) * scale,
    high: Number(c.high) * scale,
    low: Number(c.low) * scale,
    close: Number(c.close) * scale,
    volume: Number(c.volume),
  });

  return {
    onReady(cb: (c: unknown) => void) {
      setTimeout(() => cb({ supported_resolutions: RESOLUTIONS, supports_time: true, supports_marks: false }), 0);
    },
    searchSymbols(_u: string, _e: string, _t: string, onResult: (r: unknown[]) => void) {
      onResult([]);
    },
    resolveSymbol(_name: string, onResolved: (s: unknown) => void) {
      setTimeout(
        () =>
          onResolved({
            name: symbol,
            ticker: symbol,
            description: `${symbol} · market cap`,
            type: "crypto",
            session: "24x7",
            timezone: "Etc/UTC",
            exchange: BRAND.name,
            listed_exchange: BRAND.name,
            format: "price",
            minmov: 1,
            pricescale: 100,
            has_intraday: true,
            has_weekly_and_monthly: true,
            supported_resolutions: RESOLUTIONS,
            volume_precision: 3,
            data_status: "streaming",
            currency_code: "USD",
          }),
        0,
      );
    },
    async getBars(
      _symbolInfo: unknown,
      resolution: string,
      periodParams: { from: number; to: number; firstDataRequest: boolean },
      onHistory: (bars: Bar[], meta: { noData: boolean }) => void,
      onError: (e: string) => void,
    ) {
      try {
        await scaleReady;
        const interval = RES_TO_INTERVAL[resolution] ?? "1m";
        const candles = await v4Client.getCandles(token, interval, { limit: 5000 });
        const bars = candles
          .filter((c) => c.time >= periodParams.from && c.time <= periodParams.to)
          .map(toBar);
        onHistory(bars, { noData: bars.length === 0 });
      } catch (e) {
        onError(String(e));
      }
    },
    subscribeBars(
      _symbolInfo: unknown,
      resolution: string,
      onTick: (b: Bar) => void,
      uid: string,
    ) {
      const interval = RES_TO_INTERVAL[resolution] ?? "1m";
      // The chart throws away the subscription if it ever receives a bar older
      // than the last one it was fed, so updates must be monotonic. Feed the
      // last two candles (the previous bucket's final shape, then the live
      // one), skipping anything that would go backwards.
      let lastTime = 0;
      const id = setInterval(async () => {
        try {
          const candles = await v4Client.getCandles(token, interval, { limit: 2 });
          for (const c of candles.slice(-2)) {
            const bar = toBar(c);
            if (bar.time >= lastTime) {
              onTick(bar);
              lastTime = bar.time;
            }
          }
        } catch {
          /* ignore */
        }
      }, 5_000);
      subs.set(uid, id);
    },
    unsubscribeBars(uid: string) {
      const id = subs.get(uid);
      if (id) clearInterval(id);
      subs.delete(uid);
    },
  };
}
