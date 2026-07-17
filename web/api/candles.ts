import type { CandleInterval } from "@launchpad/sdk";

import { fail, reader, sendJson } from "./_reader";

/** GET /api/candles?token=0x…&interval=5m&limit=500 — OHLCV bars. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = url.searchParams.get("token");
    if (!token) {
      res.statusCode = 400;
      res.setHeader("cache-control", "no-store");
      res.end('{"error":"token required"}');
      return;
    }
    const interval = (url.searchParams.get("interval") ?? "5m") as CandleInterval;
    const limit = Math.min(Number(url.searchParams.get("limit")) || 500, 1000);
    const candles = await reader.getCandles(token as `0x${string}`, interval, { limit });
    sendJson(res, candles, 5, 30);
  } catch (err) {
    fail(res, err);
  }
}
