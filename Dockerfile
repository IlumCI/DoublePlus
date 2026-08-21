# Root Dockerfile so PaaS hosts that build from the repo root with default
# settings (Back4app Containers, etc.) build the Arc Tor RPC gateway without
# extra path configuration. Vercel ignores this file (the web app deploys via
# the Vercel CLI, not Docker). Source lives in gateway/.
FROM node:22-alpine

RUN apk add --no-cache tor

WORKDIR /app
COPY gateway/package.json ./
RUN npm install --omit=dev
COPY gateway/server.mjs gateway/start.sh ./
RUN chmod +x start.sh

EXPOSE 8080
ENV PORT=8080 TOR_SOCKS=socks5h://127.0.0.1:9050

CMD ["./start.sh"]
