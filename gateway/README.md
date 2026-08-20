# Arc Tor-to-clearnet RPC gateway

Browsers, wallets and bots cannot resolve `.onion` addresses. This service runs
a Tor client next to a small proxy so an ordinary HTTPS URL forwards JSON-RPC to
the Arc mainnet onion endpoint over Tor.

```
wallet / arcx.fun / bot  ->  https://your-host  ->  (Tor)  ->  arc .onion RPC
```

## Run it

Any host with Docker (a $5 VPS, Fly.io, Railway, or your own box):

```sh
cd gateway
# optional: require a key so it isn't an open proxy
export ACCESS_KEY=$(openssl rand -hex 16)
docker compose up -d --build
```

The gateway now listens on `:8080`. Test it:

```sh
curl -s -X POST "http://localhost:8080/?key=$ACCESS_KEY" \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
# -> {"jsonrpc":"2.0","id":1,"result":"0x13b2"}   (0x13b2 = 5042)
```

## Deploy from GitHub (no VPS, free)

GitHub cannot run the server itself, but these hosts build it straight from this
repo and give you an HTTPS URL with auto-redeploy on every push:

**Koyeb (recommended, free tier stays always-on)**
1. https://app.koyeb.com -> Create Service -> GitHub -> pick this repo.
2. Work directory: `gateway`. Builder: Dockerfile. Port: `8080`.
3. Add env var `ACCESS_KEY` (any random string). Deploy.
4. You get `https://<name>.koyeb.app`.

**Render (free, but sleeps when idle)**
1. https://render.com -> New + -> Blueprint -> pick this repo (it reads
   `gateway/render.yaml`).
2. Set `ACCESS_KEY` when prompted. Deploy -> `https://arc-tor-rpc.onrender.com`.

Both already serve HTTPS, so you can skip the reverse-proxy step below.

## Put it behind HTTPS (self-hosted only)

Wallets require https. Terminate TLS with Caddy (simplest) or any reverse proxy:

```
rpc.arcx.fun {
    reverse_proxy localhost:8080
}
```

Caddy fetches a certificate automatically, giving you
`https://rpc.arcx.fun`.

## Point arcx.fun at it

In `web/.env.production.local`, put the clearnet URL first in the RPC list:

```
VITE_RPC_URL=https://rpc.arcx.fun/?key=<ACCESS_KEY>,/api/rpc,https://arc-mainnet.cloud.blockscout.com/api/eth-rpc
```

Then rebuild and deploy. The same URL also works directly in MetaMask
(Add network -> RPC URL) and in bots/scripts.

## Notes

- Tor adds latency (~0.5-2s per call). Fine for wallet reads and launches;
  heavy indexers should prefer a direct RPC when one is available.
- Requests and responses are capped at 1 MB.
- If `ACCESS_KEY` is unset the endpoint is open; set one for anything public.
- The onion or SOCKS address can be overridden with the `ONION_RPC` /
  `TOR_SOCKS` environment variables.
