# Tor client + explorer reverse proxy. Deploy as its own service (Back4app
# Root Directory: gateway-explorer) so explorer load never affects the RPC
# gateway.
FROM node:22-alpine
RUN apk add --no-cache tor
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev
COPY server.mjs start.sh ./
RUN chmod +x start.sh
EXPOSE 8080
ENV PORT=8080 TOR_SOCKS=socks5h://127.0.0.1:9050
CMD ["./start.sh"]
