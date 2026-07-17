import * as http from "http";
import { WebSocketServer, type WebSocket } from "ws";

import { createApi } from "./api";
import { config } from "./config";
import { openDb } from "./db";
import { Hub } from "./hub";
import { Indexer } from "./indexer";

const VALID_CHANNELS = new Set(["trade:update", "price:update", "candle:update", "token:launched"]);

async function main() {
  const db = openDb();
  const hub = new Hub();
  const indexer = new Indexer(db, hub);

  const app = createApi(db, indexer.client);
  const server = http.createServer(app);

  const wss = new WebSocketServer({ server, path: "/ws" });
  wss.on("connection", (ws: WebSocket) => {
    ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(String(raw));
      } catch {
        return ws.send(JSON.stringify({ channel: "error", message: "invalid json" }));
      }
      const { op, channel, token, interval } = msg ?? {};
      if (!VALID_CHANNELS.has(channel)) {
        return ws.send(JSON.stringify({ channel: "error", message: "unknown channel" }));
      }
      if (op === "subscribe") {
        hub.subscribe(ws, channel, token, interval);
        ws.send(JSON.stringify({ channel: "subscribed", topic: channel, token }));
      } else if (op === "unsubscribe") {
        hub.unsubscribe(ws, channel, token, interval);
        ws.send(JSON.stringify({ channel: "unsubscribed", topic: channel, token }));
      }
    });
    ws.on("close", () => hub.drop(ws));
    ws.on("error", () => hub.drop(ws));
  });

  // Heartbeat so dead connections get reaped.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if ((ws as any).isAlive === false) {
        hub.drop(ws as WebSocket);
        return ws.terminate();
      }
      (ws as any).isAlive = false;
      ws.ping();
    }
  }, 30_000);
  wss.on("connection", (ws) => {
    (ws as any).isAlive = true;
    ws.on("pong", () => ((ws as any).isAlive = true));
  });

  await indexer.start();

  server.listen(config.port, () => {
    console.log(`launchpad backend listening on :${config.port}`);
    console.log(`REST  http://localhost:${config.port}/api`);
    console.log(`WS    ws://localhost:${config.port}/ws`);
  });

  const shutdown = () => {
    clearInterval(heartbeat);
    indexer.stop();
    wss.close();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
