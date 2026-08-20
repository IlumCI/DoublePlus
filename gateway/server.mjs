// Tor-to-clearnet JSON-RPC gateway for the Arc mainnet .onion endpoint.
// Browsers, wallets and bots cannot resolve .onion; this server runs alongside
// a Tor client and forwards clearnet HTTP(S) JSON-RPC requests to the onion
// over Tor's SOCKS5 proxy, adding CORS so any origin can call it.
import http from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";

const PORT = Number(process.env.PORT ?? 8080);
const SOCKS = process.env.TOR_SOCKS ?? "socks5h://127.0.0.1:9050";
// Onion RPC (http; Tor provides the transport encryption). Override via env.
const ONION =
  process.env.ONION_RPC ??
  "http://t6bmjag46e5l6tb25yojjqlabzmbpjylcffyyffa5d3ghmku6m7rcrad.onion/";
// Optional shared secret: when set, callers must include ?key=... so the
// endpoint is not an open proxy.
const ACCESS_KEY = process.env.ACCESS_KEY ?? "";

const onion = new URL(ONION);
// keepAlive reuses the Tor circuit/socket across calls instead of building a
// new one per request; the biggest single latency win over Tor.
const agent = new SocksProxyAgent(SOCKS, { keepAlive: true, maxSockets: 32, timeout: 60_000 });

// Tiny read-through cache: identical read calls (the token list, prices,
// receipts every visitor fetches) collapse into one Tor round trip within the
// TTL. Never caches writes or gas estimation.
const CACHE_TTL_MS = 6_000;
// How long a last-good response may be served when the onion 429s / errors,
// so a rate-limit storm degrades to slightly-stale data instead of failures.
const STALE_TTL_MS = 60_000;
const cache = new Map(); // bodyKey -> { at, status, text }
const inflight = new Map(); // bodyKey -> Promise<{status,text}>
const NO_CACHE = /"method"\s*:\s*"eth_(sendRawTransaction|sendTransaction|estimateGas)"/;
function cacheGet(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit;
  return null;
}
function cacheGetStale(key) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < STALE_TTL_MS) return hit;
  return null;
}
function cacheSet(key, status, text) {
  if (cache.size > 2000) {
    // Drop the oldest ~half by insertion order.
    let n = 0;
    for (const k of cache.keys()) {
      cache.delete(k);
      if (++n > 1000) break;
    }
  }
  cache.set(key, { at: Date.now(), status, text });
}

function cors(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, GET, OPTIONS");
}

// Lightweight usage stats: total requests, a rolling 60s rate, cache hits, and
// distinct client IPs seen in the last 10 minutes (a rough "active users").
const stats = { total: 0, cacheHits: 0, startedAt: Date.now() };
const recentReqs = []; // timestamps, last 60s
const ipsSeen = new Map(); // ip -> last-seen ms
function noteRequest(req) {
  const now = Date.now();
  stats.total++;
  recentReqs.push(now);
  while (recentReqs.length && now - recentReqs[0] > 60_000) recentReqs.shift();
  const ip = (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "?";
  ipsSeen.set(ip, now);
  for (const [k, t] of ipsSeen) if (now - t > 600_000) ipsSeen.delete(k);
}

const server = http.createServer((req, res) => {
  cors(res);
  const url = new URL(req.url, "http://localhost");

  if (req.method === "OPTIONS") return res.writeHead(204).end();

  // Usage snapshot (no key required; read-only counts, no user data).
  if (req.method === "GET" && url.pathname === "/__stats") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        totalRequests: stats.total,
        requestsLast60s: recentReqs.length,
        activeUsers10m: ipsSeen.size,
        cacheHits: stats.cacheHits,
        uptimeMin: Math.round((Date.now() - stats.startedAt) / 60_000),
      }),
    );
  }

  // Liveness: GET / returns 200 immediately (no Tor) so platform health checks
  // pass the moment the process binds, even while Tor is still bootstrapping.
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end('{"status":"ok"}');
  }

  // Deep check: GET /health does a real chain read over Tor.
  if (req.method === "GET" && url.pathname === "/health") {
    fetchUpstream('{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', false)
      .then(({ status, text }) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(text);
      })
      .catch((e) => {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: String(e?.message || e) }));
      });
    return;
  }

  if (req.method !== "POST") {
    res.writeHead(405, { "content-type": "application/json" });
    return res.end('{"error":"POST only"}');
  }
  if (ACCESS_KEY && url.searchParams.get("key") !== ACCESS_KEY) {
    res.writeHead(401, { "content-type": "application/json" });
    return res.end('{"error":"unauthorized"}');
  }

  let body = "";
  let tooBig = false;
  req.on("data", (c) => {
    body += c;
    if (body.length > 1_000_000) {
      tooBig = true;
      req.destroy();
    }
  });
  req.on("end", async () => {
    if (tooBig) return;
    noteRequest(req);
    const cacheable = body.length < 64_000 && !NO_CACHE.test(body);
    if (cacheable) {
      const hit = cacheGet(body);
      if (hit) {
        stats.cacheHits++;
        res.writeHead(hit.status, { "content-type": "application/json", "x-cache": "hit" });
        return res.end(hit.text);
      }
    }
    try {
      const { status, text } = await fetchUpstream(body, cacheable);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(text);
    } catch (e) {
      // On upstream failure (incl. 429), serve a slightly-stale cached answer
      // if we have one, rather than an error.
      if (cacheable) {
        const stale = cacheGetStale(body);
        if (stale) {
          stats.cacheHits++;
          res.writeHead(stale.status, { "content-type": "application/json", "x-cache": "stale" });
          return res.end(stale.text);
        }
      }
      res.writeHead(502, { "content-type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message: "tor upstream: " + (e?.message || e) } }));
    }
  });
});

// Fetch from the onion with in-flight coalescing: concurrent identical
// requests share a single Tor round trip. Throws on 429/5xx/errors so the
// caller can fall back to stale cache.
function fetchUpstream(body, cacheable) {
  if (cacheable) {
    const dup = inflight.get(body);
    if (dup) return dup;
  }
  const p = new Promise((resolve, reject) => {
    const upstream = http.request(
      {
        protocol: onion.protocol,
        host: onion.hostname,
        port: onion.port || 80,
        path: onion.pathname,
        method: "POST",
        agent,
        headers: { "content-type": "application/json", "content-length": Buffer.byteLength(body) },
        timeout: 30_000,
      },
      (up) => {
        const status = up.statusCode ?? 502;
        let text = "";
        up.setEncoding("utf8");
        up.on("data", (c) => (text += c));
        up.on("end", () => {
          if (status === 200 && text.startsWith("{") ) {
            if (cacheable) cacheSet(body, status, text);
            resolve({ status, text });
          } else {
            // 429 / html error / non-JSON: treat as failure for stale fallback.
            reject(new Error("upstream status " + status));
          }
        });
      },
    );
    upstream.on("timeout", () => upstream.destroy(new Error("tor upstream timeout")));
    upstream.on("error", reject);
    upstream.end(body);
  }).finally(() => {
    if (cacheable) inflight.delete(body);
  });
  if (cacheable) inflight.set(body, p);
  return p;
}

server.listen(PORT, () => console.log(`arc tor gateway on :${PORT} -> ${onion.hostname} via ${SOCKS}`));
