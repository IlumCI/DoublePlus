// doubleplus.fun's Worker. Everything is a static asset (dist/, the SPA)
// except what a crawler needs and the browser bundle can't give it:
//   /venture/0x…        the page with that coin's own title, description and
//                       image, so a link posted to X, Telegram or Discord
//                       previews the coin rather than the site
//   /og/0x….webp        the coin's logo as an image file (logos ride on-chain
//                       as data URIs, which no preview fetcher loads)
//   /sitemap.xml        every coin page, for search engines
// wrangler.toml routes only these paths here; the rest never runs this code.
import { createPublicClient, fallback, http, parseAbi } from "viem";
import dep from "../contracts/deployments/venture-robinhood.json";

const SITE = "https://doubleplus.fun";
// Daybreak first: Robinhood's own RPC throttles Cloudflare's shared egress.
const RPCS = ["https://robinhood.daybreak-rpc.network", "https://rpc.mainnet.chain.robinhood.com"];
const FACTORY = dep.contracts.factory;
// $DOUBLEPLUS, relaunched on Flap (src/venture/house.ts): it keeps the first
// launch's pitch, and the first launch leaves the sitemap.
const HOUSE = "0xc40f1686f7252a372ea98164dd750897f83c7777";
const HOUSE_FIRST = "0xc44cfd968a38c6b16a8be4677bbb87d0ebb42add";
const PAGE_TTL = 300; // coin previews: a name never changes, a logo never does
const MAP_TTL = 3600;

const factoryAbi = parseAbi([
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function curveState(address) view returns (uint64 deadline, uint128 price, uint256 soldWhole, uint256 remainingWhole, uint256 raisedWei, uint256 targetRaiseWei, bool finalized, bool aborted)",
]);
const tokenAbi = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function metadataURI() view returns (string)",
]);

const client = () => createPublicClient({
  transport: fallback(RPCS.map((u) => http(u, { timeout: 5_000, retryCount: 0 }))),
});

/** A coin of this factory, or null for any other address (every launch
 *  sets a target, and the factory holds none for a token it never launched),
 *  so a page can't dress an arbitrary contract up as a DoublePlus coin. */
async function readCoin(address) {
  if (address.toLowerCase() === HOUSE) {
    const first = await readCoin(HOUSE_FIRST).catch(() => null);
    return { name: "DoublePlusFun", symbol: "DOUBLEPLUS", pitch: first?.pitch ?? "", logo: `${SITE}/doubleplus-logo.png` };
  }
  const pc = client();
  const st = await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "curveState", args: [address] }).catch(() => null);
  if (!st || st[5] === 0n) return null;
  const [name, symbol, metaRaw] = await Promise.all(["name", "symbol", "metadataURI"].map((fn) =>
    pc.readContract({ address, abi: tokenAbi, functionName: fn }).catch(() => "")));
  let meta = {};
  try { const m = JSON.parse(metaRaw); if (m && typeof m === "object" && !Array.isArray(m)) meta = m; } catch { /* no metadata */ }
  return { name: clean(name, 64), symbol: clean(symbol, 16), pitch: clean(meta.pitch, 200), logo: typeof meta.logo === "string" ? meta.logo : "" };
}

// Creator text, made safe for an attribute: invisible and direction-changing
// characters out (as the app's safe.ts does), whitespace collapsed, capped.
function clean(v, max) {
  if (typeof v !== "string") return "";
  const t = v.replace(/[\u0000-\u001F\u007F-\u009F­؜​-‏‪-‮⁠-⁩﻿]/g, " ").replace(/\s+/g, " ").trim();
  const chars = [...t];
  return chars.length > max ? chars.slice(0, max).join("") + "…" : t;
}
const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** The logo a preview can load: an inline png/jpeg/webp/gif, decoded. */
function logoBytes(logo) {
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,([a-z0-9+/=]+)$/i.exec(logo);
  if (!m) return null;
  const bin = atob(m[2]);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  const ext = m[1].toLowerCase().replace("jpeg", "jpg");
  return { type: `image/${ext.replace("jpg", "jpeg")}`, ext, bytes: out };
}

async function coinPage(request, env, address) {
  const page = await env.ASSETS.fetch(new Request(new URL("/", request.url), request));
  const coin = await readCoin(address).catch(() => null);
  if (!coin || !page.ok) return page;
  const title = `${coin.name} ($${coin.symbol}) · doubleplus.fun`;
  const desc = coin.pitch || `$${coin.symbol} on doubleplus.fun, Robinhood Chain.`;
  const url = `${SITE}/venture/${address}`;
  // A square logo reads as the small card; with none, the site's banner.
  const inline = logoBytes(coin.logo);
  const own = inline ? `${SITE}/og/${address}.${inline.ext}` : /^https:\/\/[^\s"'<>]+$/i.test(coin.logo) ? coin.logo : "";
  const image = own || `${SITE}/doubleplus-card.png`;
  const tags =
    `<title>${esc(title)}</title>\n` +
    `<meta name="description" content="${esc(desc)}" />\n` +
    `<link rel="canonical" href="${url}" />\n` +
    `<meta property="og:title" content="${esc(title)}" />\n` +
    `<meta property="og:description" content="${esc(desc)}" />\n` +
    `<meta property="og:type" content="website" />\n` +
    `<meta property="og:url" content="${url}" />\n` +
    `<meta property="og:image" content="${esc(image)}" />\n` +
    `<meta name="twitter:card" content="${own ? "summary" : "summary_large_image"}" />\n` +
    `<meta name="twitter:site" content="@DoublePlusFund" />\n` +
    `<meta name="twitter:title" content="${esc(title)}" />\n` +
    `<meta name="twitter:description" content="${esc(desc)}" />\n` +
    `<meta name="twitter:image" content="${esc(image)}" />\n`;
  // The site-wide tags go, so a crawler reading the first of each sees the coin.
  const html = (await page.text())
    .replace(/<title>[^<]*<\/title>/, "")
    .replace(/<meta\s+name="description"\s+content="[^"]*"\s*\/>/, "")
    .replace(/<meta (property="og:[^"]+"|name="twitter:[^"]+") content="[^"]*" \/>\s*/g, "")
    .replace("</head>", `${tags}</head>`);
  const headers = new Headers(page.headers);
  headers.set("cache-control", `public, max-age=0, s-maxage=${PAGE_TTL}`);
  headers.delete("content-length");
  return new Response(html, { status: 200, headers });
}

async function coinImage(address) {
  const coin = await readCoin(address).catch(() => null);
  const img = coin && logoBytes(coin.logo);
  if (!img) return Response.redirect(`${SITE}/doubleplus-card.png`, 302);
  return new Response(img.bytes, { headers: { "content-type": img.type, "cache-control": "public, max-age=86400" } });
}

async function sitemap() {
  const pc = client();
  const total = Number(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "totalTokens" }));
  const coins = [];
  for (let i = 0; i < total; i += 50) {
    const ids = Array.from({ length: Math.min(50, total - i) }, (_, k) => BigInt(i + k));
    coins.push(...await Promise.all(ids.map((n) => pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "allTokens", args: [n] }))));
  }
  const paths = ["/", "/launch", "/docs", "/stats", "/stocks", "/rewards", `/venture/${HOUSE}`,
    ...coins.reverse().filter((c) => c.toLowerCase() !== HOUSE_FIRST).map((c) => `/venture/${c}`)];
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    paths.map((p) => `  <url><loc>${SITE}${p}</loc></url>`).join("\n") + `\n</urlset>\n`;
  return new Response(xml, { headers: { "content-type": "application/xml; charset=utf-8", "cache-control": `public, max-age=${MAP_TTL}` } });
}

/** Answers from Cloudflare's cache when it can, so a link going viral costs
 *  the RPC one read per TTL rather than one per crawler. */
async function cached(request, ctx, make) {
  const cache = caches.default;
  const key = new Request(new URL(request.url).toString(), { method: "GET" });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await make();
  if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);
    if (request.method !== "GET" && request.method !== "HEAD") return env.ASSETS.fetch(request);
    let m;
    if ((m = /^\/venture\/(0x[0-9a-fA-F]{40})\/?$/.exec(pathname))) return cached(request, ctx, () => coinPage(request, env, m[1]));
    if ((m = /^\/og\/(0x[0-9a-fA-F]{40})\.(png|jpg|webp|gif)$/.exec(pathname))) return cached(request, ctx, () => coinImage(m[1]));
    if (pathname === "/sitemap.xml") return cached(request, ctx, () => sitemap().catch(() => new Response("sitemap unavailable", { status: 503 })));
    return env.ASSETS.fetch(request);
  },
};
