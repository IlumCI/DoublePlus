# Single image: Tor client + the Node gateway. Tor bootstraps, then the
# gateway proxies clearnet JSON-RPC to the Arc .onion over Tor's SOCKS5.
FROM node:22-alpine

RUN apk add --no-cache tor

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs ./
COPY start.sh ./
RUN chmod +x start.sh

# Gateway listens here; Tor SOCKS stays internal on 9050.
EXPOSE 8080
ENV PORT=8080 TOR_SOCKS=socks5h://127.0.0.1:9050

CMD ["./start.sh"]
