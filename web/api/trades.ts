import { fail, reader, sendJson } from "./_reader";

/** GET /api/trades?token=0x…&limit=50 — recent trades for a market. */
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
    const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 200);
    const trades = await reader.getTrades(token as `0x${string}`, { limit });
    // Shorter window: trades change more often than the token list.
    sendJson(res, trades, 5, 30);
  } catch (err) {
    fail(res, err);
  }
}
