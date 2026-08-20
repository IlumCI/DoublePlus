// Same-origin USD price relay: the browser asks us, we ask Blockscout
// server-side. Sidesteps carrier bot walls that block direct browser
// fetches to blockscout.com from phones.
const BASE = "https://robinhoodchain.blockscout.com/api/v2/tokens/";

export default async function handler(req, res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("cache-control", "s-maxage=30, stale-while-revalidate=120");
  const token = String(req.query?.token ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(token)) return res.status(400).json({ usd: 0 });
  try {
    const r = await fetch(BASE + token, { headers: { accept: "application/json" } });
    if (r.ok) {
      const j = await r.json();
      const v = Number(j?.exchange_rate);
      if (Number.isFinite(v) && v > 0) return res.status(200).json({ usd: v });
    }
  } catch {
    /* fall through */
  }
  return res.status(200).json({ usd: 0 });
}
