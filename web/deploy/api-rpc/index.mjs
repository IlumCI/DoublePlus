// Same-origin JSON-RPC relay: browsers talk to arcx.fun only, the server
// forwards to the real Arc RPC. Sidesteps mobile carriers or bot walls that
// block direct cross-origin RPC POSTs from phones.
const UPSTREAM =
  process.env.RPC_UPSTREAM ??
  "https://real-pump-soon-trust-me-bro-again.poptyedev.com/b71fac7173778c3f6a9148c157b8b4f61d275b447b087327";

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? null);
    const upstream = await fetch(UPSTREAM, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    const text = await upstream.text();
    res.status(upstream.status).setHeader("content-type", "application/json").send(text);
  } catch {
    res.status(502).json({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "upstream unreachable" } });
  }
}
