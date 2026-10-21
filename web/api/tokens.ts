import { fail, limitParam, reader, sendJson } from "./_reader";

const SORTS = new Set(["new", "volume", "marketCap"]);

/** GET /api/tokens?sort=new|volume|marketCap&limit=60 — the Discover feed. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const raw = url.searchParams.get("sort") ?? "new";
    const sort = (SORTS.has(raw) ? raw : "new") as any;
    const limit = limitParam(url.searchParams.get("limit"), 60, 100);
    const tokens = await reader.getTokens({ sort, limit });
    sendJson(res, tokens, 8, 30);
  } catch (err) {
    fail(res, err);
  }
}
