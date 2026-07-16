import type { CandleInterval, WsServerMessage } from "./types";

type Listener = (msg: WsServerMessage) => void;

interface Subscription {
  key: string;
  payload: Record<string, string>;
  listener: Listener;
}

/**
 * Small resilient WebSocket client for the launchpad stream. Reconnects with
 * backoff and replays active subscriptions after reconnecting.
 */
export class LaunchpadSocket {
  private url: string;
  private ws: WebSocket | null = null;
  private subs = new Map<string, Set<Subscription>>();
  private closed = false;
  private backoffMs = 500;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(url: string) {
    this.url = url;
  }

  private ensureConnected() {
    if (this.closed || this.ws) return;
    const WS: typeof WebSocket | undefined = (globalThis as any).WebSocket;
    if (!WS) throw new Error("No WebSocket implementation available in this environment");

    const ws = new WS(this.url);
    this.ws = ws;

    ws.onopen = () => {
      this.backoffMs = 500;
      for (const set of this.subs.values()) {
        for (const sub of set) {
          ws.send(JSON.stringify({ op: "subscribe", ...sub.payload }));
        }
      }
    };

    ws.onmessage = (event: MessageEvent) => {
      let msg: WsServerMessage;
      try {
        msg = JSON.parse(String(event.data));
      } catch {
        return;
      }
      const anyMsg = msg as any;
      const keys = [
        this.key(anyMsg.channel, anyMsg.token, anyMsg.data?.interval),
        this.key(anyMsg.channel, anyMsg.token),
        this.key(anyMsg.channel, "*"),
      ];
      for (const key of keys) {
        const set = this.subs.get(key);
        if (set) for (const sub of set) sub.listener(msg);
      }
    };

    ws.onclose = () => {
      this.ws = null;
      if (this.closed || this.subs.size === 0) return;
      this.connectTimer = setTimeout(() => this.ensureConnected(), this.backoffMs);
      this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
    };

    ws.onerror = () => {
      try {
        ws.close();
      } catch {
        // ignore
      }
    };
  }

  private key(channel: string, token?: string, interval?: string) {
    return [channel, (token ?? "*").toLowerCase(), interval ?? ""].join("|");
  }

  subscribe(
    channel: "trade:update" | "price:update" | "candle:update" | "token:launched",
    params: { token?: string; interval?: CandleInterval },
    listener: Listener
  ): () => void {
    const payload: Record<string, string> = { channel };
    if (params.token) payload.token = params.token.toLowerCase();
    if (params.interval) payload.interval = params.interval;

    const key = this.key(channel, params.token, params.interval);
    const sub: Subscription = { key, payload, listener };
    let set = this.subs.get(key);
    if (!set) {
      set = new Set();
      this.subs.set(key, set);
    }
    set.add(sub);

    this.ensureConnected();
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ op: "subscribe", ...payload }));
    }

    return () => {
      const s = this.subs.get(key);
      if (!s) return;
      s.delete(sub);
      if (s.size === 0) {
        this.subs.delete(key);
        if (this.ws && this.ws.readyState === 1) {
          this.ws.send(JSON.stringify({ op: "unsubscribe", ...payload }));
        }
      }
    };
  }

  close() {
    this.closed = true;
    if (this.connectTimer) clearTimeout(this.connectTimer);
    this.ws?.close();
    this.ws = null;
    this.subs.clear();
  }
}
