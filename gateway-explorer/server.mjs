// Tor-to-clearnet reverse proxy for the Arc block explorer .onion site.
// Forwards every request (any method, path, query) to the explorer over Tor's
// SOCKS5 and streams the response back, so browsers reach it on an ordinary
// https URL. Kept separate from the RPC gateway so explorer load never affects
// RPC uptime.
import http from "node:http";
import { SocksProxyAgent } from "socks-proxy-agent";

const PORT = Number(process.env.PORT ?? 8080);
const SOCKS = process.env.TOR_SOCKS ?? "socks5h://127.0.0.1:9050";
const EXPLORER =
  process.env.EXPLORER_ONION ??
  "http://5fcjnymrlmpvkukeqwpmfbag65g6f5qgjeucnbfvfm3apvqmhv5lfoqd.onion/";

const onion = new URL(EXPLORER);
const agent = new SocksProxyAgent(SOCKS);
const HOP = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
  "te", "trailer", "transfer-encoding", "upgrade",
]);

const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://localhost");

  // Fast liveness so platform health checks never wait on Tor.
  if (req.method === "GET" && url.pathname === "/__health") {
    res.writeHead(200, { "content-type": "text/plain" });
    return res.end("ok");
  }

  const headers = { ...req.headers, host: onion.host };
  delete headers["accept-encoding"]; // let the explorer send identity so links resolve

  const upstream = http.request(
    {
      protocol: onion.protocol,
      host: onion.hostname,
      port: onion.port || 80,
      path: url.pathname + url.search,
      method: req.method,
      agent,
      headers,
      timeout: 45_000,
    },
    (up) => {
      const out = {};
      for (const [k, v] of Object.entries(up.headers)) {
        if (HOP.has(k.toLowerCase())) continue;
        // Rewrite any absolute onion location back to this host.
        if (k.toLowerCase() === "location" && typeof v === "string") {
          out[k] = v.replace(new RegExp(`https?://${onion.hostname}`, "g"), "");
        } else out[k] = v;
      }
      res.writeHead(up.statusCode ?? 502, out);
      up.pipe(res);
    },
  );
  upstream.on("timeout", () => upstream.destroy(new Error("tor upstream timeout")));
  upstream.on("error", (e) => {
    if (res.headersSent) return res.end();
    res.writeHead(502, { "content-type": "text/plain" });
    res.end("explorer gateway upstream error: " + e.message);
  });
  req.pipe(upstream);
});

server.listen(PORT, () => console.log(`arc explorer gateway on :${PORT} -> ${onion.hostname} via ${SOCKS}`));
