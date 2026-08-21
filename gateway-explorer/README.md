# Arc explorer Tor-to-clearnet gateway

Reverse-proxies the Arc block explorer `.onion` site to an ordinary HTTPS URL
over Tor, so `Scan` / explorer links on arcx.fun work while the clearnet
explorer is gated and Blockscout is down. Kept separate from the RPC gateway so
explorer traffic never affects RPC uptime.

## Deploy (Back4app, second service)

1. New App -> Container -> pick this repo, branch `claude/arc-inspired-crypto-app-if7yel`.
2. **Root Directory:** `gateway-explorer`
3. **Port:** `8080`
4. **Health -> Path:** `/__health`
5. Deploy. You get an https URL like `https://arcexplorer-xxxx.b4a.run`.

Then set `VITE_EXPLORER_URL` in `web/.env.production.local` to that URL,
rebuild and deploy the site.

## Notes

- Tor adds latency; explorer pages load in a couple of seconds.
- Live/websocket features of the explorer may not work through the proxy, but
  tx / address / token pages render fine.
- Override the target with the `EXPLORER_ONION` environment variable.
