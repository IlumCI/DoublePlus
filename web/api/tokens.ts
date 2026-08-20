import { fail, reader, sendJson } from "./_reader";

/** GET /api/tokens?sort=new|volume|marketCap&limit=60 — the Discover feed. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const sort = (url.searchParams.get("sort") as any) ?? "new";
    const limit = Math.min(Number(url.searchParams.get("limit")) || 60, 100);
    const tokens = await reader.getTokens({ sort, limit });
    sendJson(res, tokens, 8, 30);
  } catch (err) {
    fail(res, err);
  }
}
