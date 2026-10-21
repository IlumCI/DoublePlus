import { addressParam, badRequest, fail, limitParam, reader, sendJson } from "./_reader";

/** GET /api/trades?token=0x…&limit=50 — recent trades for a market. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const token = addressParam(url.searchParams.get("token"));
    if (!token) return badRequest(res, "token required");
    const limit = limitParam(url.searchParams.get("limit"), 50, 200);
    const trades = await reader.getTrades(token, { limit });
    // Shorter window: trades change more often than the token list.
    sendJson(res, trades, 5, 30);
  } catch (err) {
    fail(res, err);
  }
}
