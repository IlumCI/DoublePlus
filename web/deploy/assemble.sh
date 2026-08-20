#!/usr/bin/env bash
# Assemble .vercel/output (Build Output API v3) from dist/ plus the RPC relay.
set -euo pipefail
cd "$(dirname "$0")/.."
rm -rf .vercel/output
mkdir -p .vercel/output/functions/api/rpc.func .vercel/output/functions/api/usd.func
cp -r dist .vercel/output/static
# Bundle the bridge relays + reward keeper (viem inlined; Vercel functions
# ship no deps).
for FN in bridge-out bridge-in keeper; do
  mkdir -p ".vercel/output/functions/api/${FN}.func"
  npx esbuild "deploy/api-${FN}/index.ts" --bundle --platform=node --format=esm \
    --outfile=".vercel/output/functions/api/${FN}.func/index.mjs" --log-level=warning
  cat > ".vercel/output/functions/api/${FN}.func/.vc-config.json" <<'JSON'
{
  "runtime": "nodejs22.x",
  "handler": "index.mjs",
  "launcherType": "Nodejs",
  "shouldAddHelpers": true,
  "maxDuration": 60
}
JSON
done
# Stamp the deploy so /debug can prove which build a device is seeing.
BUNDLE=$(ls .vercel/output/static/assets/index-*.js | head -1 | xargs basename)
printf '{"builtAt":"%s","bundle":"%s"}' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$BUNDLE" > .vercel/output/static/version.json
cp deploy/api-rpc/index.mjs deploy/api-rpc/.vc-config.json .vercel/output/functions/api/rpc.func/
cp deploy/api-usd/index.mjs deploy/api-usd/.vc-config.json .vercel/output/functions/api/usd.func/
cat > .vercel/output/config.json <<'JSON'
{
  "version": 3,
  "routes": [
    { "src": "^/api/rpc$", "dest": "/api/rpc" },
    { "src": "^/api/usd$", "dest": "/api/usd" },
    { "src": "^/api/bridge-out$", "dest": "/api/bridge-out" },
    { "src": "^/api/bridge-in$", "dest": "/api/bridge-in" },
    { "src": "^/api/keeper$", "dest": "/api/keeper" },
    { "handle": "filesystem" },
    { "src": "/(.*)", "dest": "/index.html" }
  ],
  "crons": [{ "path": "/api/keeper", "schedule": "*/10 * * * *" }]
}
JSON
echo "assembled .vercel/output"
