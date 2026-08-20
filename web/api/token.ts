import { fail, reader, sendJson } from "./_reader";

/** GET /api/token?address=0x… — one token's full summary. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const address = url.searchParams.get("address");
    if (!address) {
      res.statusCode = 400;
      res.setHeader("cache-control", "no-store");
      res.end('{"error":"address required"}');
      return;
    }
    const token = await reader.getToken(address as `0x${string}`);
    sendJson(res, token, 8, 30);
  } catch (err) {
    fail(res, err);
  }
}
