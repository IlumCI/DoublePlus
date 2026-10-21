import { addressParam, badRequest, fail, reader, sendJson } from "./_reader";

/** GET /api/token?address=0x… — one token's full summary. */
export default async function handler(req: any, res: any): Promise<void> {
  try {
    const url = new URL(req.url, "http://localhost");
    const address = addressParam(url.searchParams.get("address"));
    if (!address) return badRequest(res, "address required");
    const token = await reader.getToken(address);
    sendJson(res, token, 8, 30);
  } catch (err) {
    fail(res, err);
  }
}
