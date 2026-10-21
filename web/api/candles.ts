import type { CandleInterval } from "@launchpad/sdk";

import { addressParam, badRequest, fail, limitParam, reader, sendJson } from "./_reader";

const INTERVALS = new Set<CandleInterval>(["1m", "5m", "15m", "30m", "1h", "4h", "1d", "1w"]);

/** GET /api/candles?token=0x…&interval=5m&limit=500 — OHLCV bars. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = addressParam(url.searchParams.get("token"));
    if (!token) return badRequest(res, "token required");
    const interval = (url.searchParams.get("interval") ?? "5m") as CandleInterval;
    if (!INTERVALS.has(interval)) return badRequest(res, "bad interval");
    const limit = limitParam(url.searchParams.get("limit"), 500, 1000);
    const candles = await reader.getCandles(token, interval, { limit });
    sendJson(res, candles, 5, 30);
  } catch (err) {
    fail(res, err);
  }
}
