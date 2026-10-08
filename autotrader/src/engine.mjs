// Paper-trading engine: many accounts, one market. Signals are read once per
// coin; each account sizes, fills and exits on its own book. Fills go through
// the exact Pons curve maths after a latency delay, against the state after
// the trades that landed in between, with fee, the coin's own tax, gas, and
// the account's own earlier impact on that coin.
import { buyOut, Coin, sellOut } from "./coin.mjs";
import { CONFIG, entrySignal, exitSignal, sizeFor, socialScore } from "./strategy.mjs";

export const GAS_ETH = 5e-6; // ~200k gas at 0.02 gwei, rounded up
const TICK = 5; // s between exit sweeps of held coins
const EVAL_GAP = 2; // s between full reads of one coin
const REENTRY_COOLDOWN = 300;

function rng(seed) {
  let s = seed >>> 0 || 1;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
}

export class Account {
  constructor(id, balance, { latency = [0.4, 1.2], seed = id + 1 } = {}) {
    this.id = id;
    this.start = balance;
    this.cash = balance;
    this.positions = new Map(); // token -> { tokens, cost, entryPrice, t, high, offQ, offT, score }
    this.pending = new Set(); // tokens with an order in flight
    this.lastExit = new Map();
    this.closed = []; // { token, cost, out, ret, held, reason }
    this.gas = 0;
    this.rand = rng(seed);
    this.latency = latency;
    this.deployedSamples = [];
    this.peak = balance;
    this.maxDrawdown = 0;
  }
  lag() {
    const [a, b] = this.latency;
    return a + (b - a) * this.rand();
  }
}

export class Engine {
  constructor(accounts, cfg = CONFIG, { entryAfter = -Infinity, entryBefore = Infinity, entry = entrySignal } = {}) {
    this.entry = entry; // swappable: the Monte Carlo runs random entries through the same book
    this.accounts = accounts;
    this.cfg = cfg;
    this.entryAfter = entryAfter; // replay windows: read the past, trade only inside
    this.entryBefore = entryBefore;
    this.coins = new Map();
    this.linkUses = new Map(); // socials string -> launches using it
    this.orders = []; // { due, acct, token, side, eth?, reason }
    this.lastEval = new Map();
    this.hawkesCache = new Map();
    this.nextTick = null;
    this.now = 0;
    this.signals = []; // entry signals seen, for the report
  }

  feed(e) {
    if (this.nextTick === null) this.nextTick = e.t + TICK;
    while (this.nextTick <= e.t) {
      this._fillDue(this.nextTick);
      this._sweep(this.nextTick);
      this.nextTick += TICK;
    }
    this._fillDue(e.t);
    this.now = e.t;
    if (e.k === "launch") {
      const c = new Coin(e);
      this.coins.set(e.token, c);
      if (c.socials) this.linkUses.set(c.socials, (this.linkUses.get(c.socials) ?? 0) + 1);
      return;
    }
    const c = this.coins.get(e.token);
    if (!c) return; // launched before the window: not in the universe
    c.apply(e);
    if (e.k === "buy" || e.k === "swap") this._rungs(c, e.t);
    if ((e.k === "buy" || e.k === "sell" || e.k === "swap") && c.native) this._evaluate(c, e.t, false);
  }

  _hawkes(c, now) {
    const hit = this.hawkesCache.get(c.token);
    if (hit && now - hit.t < EVAL_GAP) return hit.h;
    const h = c.hawkes(now);
    this.hawkesCache.set(c.token, { t: now, h });
    return h;
  }

  _evaluate(c, now, sweepOnly) {
    const holders = this.accounts.filter((a) => a.positions.has(c.token) && !a.pending.has(c.token));
    const last = this.lastEval.get(c.token) ?? -Infinity;
    if (!holders.length && (sweepOnly || now - last < EVAL_GAP)) return;
    this.lastEval.set(c.token, now);
    const f = c.features(now);
    const h = this._hawkes(c, now);
    for (const a of holders) {
      const pos = a.positions.get(c.token);
      if (f.price > pos.high) pos.high = f.price;
      const why = exitSignal(f, h, pos, now, this.cfg);
      if (why) this._order(a, c.token, "sell", now, { reason: why });
    }
    if (sweepOnly || c.graduated || now < this.entryAfter || now >= this.entryBefore) return;
    const social = socialScore(c.socials, this.linkUses.get(c.socials) ?? 0);
    const sig = this.entry(f, h, social, this.cfg, c);
    if (!sig.go) return;
    this.signals.push({ t: now, token: c.token, score: sig.score, price: f.price, progress: f.progress });
    for (const a of this.accounts) {
      if (a.positions.has(c.token) || a.pending.has(c.token)) continue;
      if (a.positions.size + a.pending.size >= this.cfg.maxPositions) continue;
      if (now - (a.lastExit.get(c.token) ?? -Infinity) < REENTRY_COOLDOWN) continue;
      const equity = this.equity(a);
      const eth = sizeFor(equity, a.cash - GAS_ETH, sig.score, f.Q, this.cfg);
      if (eth > 0) this._order(a, c.token, "buy", now, { eth, score: sig.score });
    }
  }

  /** Resting asks: a buy that lifts the price through a rung sells that slice
   *  into it. On Pons there is no on-chain limit order, so a keeper fires the
   *  sell and it lands after the account's latency, at whatever price then. */
  _rungs(c, now) {
    if (!this.cfg.ladder) return;
    const price = c.price();
    for (const a of this.accounts) {
      const pos = a.positions.get(c.token);
      if (!pos || a.pending.has(c.token)) continue;
      const i = pos.rungsDone ?? 0;
      const rung = this.cfg.ladder[i];
      if (!rung || price < pos.entryPrice * rung[0]) continue;
      pos.rungsDone = i + 1;
      // Fraction of what is left now that sells the rung's share of the original bag.
      const soldSoFar = this.cfg.ladder.slice(0, i).reduce((s, r) => s + r[1], 0);
      this._order(a, c.token, "sell", now, { reason: `ask-${rung[0]}x`, frac: Math.min(1, rung[1] / (1 - soldSoFar)) });
    }
  }

  _sweep(now) {
    const held = new Set();
    for (const a of this.accounts) for (const t of a.positions.keys()) held.add(t);
    for (const t of held) this._evaluate(this.coins.get(t), now, true);
    for (const a of this.accounts) {
      const eq = this.equity(a);
      a.deployedSamples.push(1 - a.cash / Math.max(eq, 1e-12));
      if (eq > a.peak) a.peak = eq;
      a.maxDrawdown = Math.max(a.maxDrawdown, 1 - eq / a.peak);
    }
  }

  _order(a, token, side, now, extra) {
    a.pending.add(token);
    this.orders.push({ due: now + a.lag(), acct: a, token, side, ...extra });
  }

  _fillDue(t) {
    if (!this.orders.length) return;
    this.orders.sort((x, y) => x.due - y.due);
    while (this.orders.length && this.orders[0].due <= t) this._fill(this.orders.shift());
  }

  _fill(o) {
    const a = o.acct;
    const c = this.coins.get(o.token);
    a.pending.delete(o.token);
    const { Q, T } = c.reserves();
    if (o.side === "buy") {
      if (a.cash < o.eth + GAS_ETH) return;
      if (c.graduated && !c.v4) return;
      const tokens = buyOut(Q, T, o.eth, c.buyTax);
      if (!(tokens > 0)) return;
      a.cash -= o.eth + GAS_ETH;
      a.gas += GAS_ETH;
      const net = o.eth * (1 - 0.01 - c.buyTax);
      a.positions.set(o.token, {
        tokens, cost: o.eth, entryPrice: o.eth / tokens, t: o.due, high: c.price(), offQ: net, offT: tokens, score: o.score,
      });
    } else {
      const pos = a.positions.get(o.token);
      if (!pos) return;
      // Our own earlier buy is still sitting in the curve as far as our exit
      // is concerned: the real market never saw it, so add it back.
      const frac = o.frac ?? 1;
      const tokens = pos.tokens * frac;
      const rQ = Q + pos.offQ, rT = Math.max(1, T - pos.offT);
      const out = sellOut(rQ, rT, tokens, c.sellTax);
      const gross = (rQ * tokens) / (rT + tokens);
      const cost = pos.cost * frac;
      a.cash += out - GAS_ETH;
      a.gas += GAS_ETH;
      a.closed.push({ token: o.token, cost, out, ret: out / cost - 1, held: o.due - pos.t, at: o.due, reason: o.reason, part: frac < 1 });
      if (frac >= 1 - 1e-12) {
        a.positions.delete(o.token);
        a.lastExit.set(o.token, o.due);
      } else {
        pos.tokens -= tokens;
        pos.cost -= cost;
        pos.offQ -= gross;
        pos.offT -= tokens;
      }
    }
  }

  /** Cash plus what every bag would sell for right now. */
  equity(a) {
    let v = a.cash;
    for (const [token, pos] of a.positions) {
      const c = this.coins.get(token);
      const { Q, T } = c.reserves();
      v += sellOut(Q + pos.offQ, Math.max(1, T - pos.offT), pos.tokens, c.sellTax);
    }
    return v;
  }

  /** Close everything at the end of the run, at the curve's last state. */
  finish() {
    this._fillDue(Infinity);
    for (const a of this.accounts) {
      for (const token of [...a.positions.keys()]) this._fill({ acct: a, token, side: "sell", due: this.now, reason: "end" });
    }
  }
}
