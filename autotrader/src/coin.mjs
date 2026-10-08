// Per-coin market state, rebuilt from the event stream alone: the Pons curve's
// reserves, who holds what, who arrived when, and the crowd features the
// strategy reads. Nothing here looks ahead: every feature is computed from the
// events seen so far.
import { fitHawkes, marks } from "./hawkes.mjs";

export const FEE = 0.01; // Pons curve fee, both sides
export const TOTAL_SUPPLY = 1e9;
const NATIVE = "0x0000000000000000000000000000000000000000";
const EARLY_SECS = 30; // the launch cohort: snipers, bundles, the fastest bots
const BETA = 0.05; // Hawkes memory ~20 s

/** Constant-product fills on virtual reserves (Q quote, T tokens), with fee
 *  and tax taken from the quote side, the way the Pons curve does it. */
export function buyOut(Q, T, ethIn, tax) {
  const net = ethIn * (1 - FEE - tax);
  if (net <= 0) return 0;
  return (T * net) / (Q + net);
}
export function sellOut(Q, T, tokensIn, tax) {
  const gross = (Q * tokensIn) / (T + tokensIn);
  return gross * (1 - FEE - tax);
}

export class Coin {
  constructor(launch) {
    this.token = launch.token;
    this.launchT = launch.t;
    this.launchBlock = launch.b;
    this.deployer = launch.deployer;
    this.native = launch.pair === NATIVE;
    this.G = Number(launch.gradQuote) / 1e18; // only meaningful for native pairs
    this.Q0 = 0.4 * this.G;
    this.T0 = TOTAL_SUPPLY;
    this.q = 0; // net quote in
    this.t = 0; // tokens out of the curve
    this.socials = (launch.socials ?? "").trim();
    this.graduated = false;
    this.v4 = null; // { x: ETH reserve, y: token reserve } once graduated
    this.trades = []; // { t, buy, eth, tokens, who, b }
    this.holders = new Map(); // wallet -> tokens
    this.firstBuyAt = new Map(); // wallet -> t
    this.early = new Set();
    this.earlyPeak = 0; // most the launch cohort ever held
    this.devTokens = 0;
    this.devPeak = 0;
    this.devSold = 0;
    this.buyTax = 0.02;
    this.sellTax = 0.02;
    this.lastT = launch.t;
    this.highPrice = this.price();
    this.blockBuys = new Map(); // block -> buy count (bundles)
  }

  /** ETH per whole token. */
  price() {
    if (this.v4) return this.v4.x / this.v4.y;
    return (this.Q0 + this.q) / (this.T0 - this.t);
  }

  /** Reserves a fill would trade against. */
  reserves() {
    if (this.v4) return { Q: this.v4.x, T: this.v4.y };
    return { Q: this.Q0 + this.q, T: this.T0 - this.t };
  }

  progress() {
    return this.G > 0 ? this.q / this.G : 0;
  }

  mcapEth() {
    return this.price() * TOTAL_SUPPLY;
  }

  earlyHeld() {
    let s = 0;
    for (const w of this.early) s += Math.max(0, this.holders.get(w) ?? 0);
    return s;
  }

  apply(e) {
    this.lastT = e.t;
    if (e.k === "buy" || e.k === "sell") {
      const eth = Number(e.quote) / 1e18;
      const tokens = Number(e.tokens) / 1e18;
      const fee = Number(e.fee) / 1e18;
      const tax = Number(e.tax) / 1e18;
      const buy = e.k === "buy";
      if (buy) {
        this.q += eth - fee - tax;
        this.t += tokens;
        if (eth > 0) this.buyTax = tax / eth;
        if (!this.firstBuyAt.has(e.who)) this.firstBuyAt.set(e.who, e.t);
        if (e.t - this.launchT <= EARLY_SECS) this.early.add(e.who);
        this.blockBuys.set(e.b, (this.blockBuys.get(e.b) ?? 0) + 1);
      } else {
        // Seller receives gross - fee - tax; gross left the reserve.
        this.q -= eth + fee + tax;
        this.t -= tokens;
        const gross = eth + fee + tax;
        if (gross > 0) this.sellTax = tax / gross;
      }
      this._move(e.who, buy ? tokens : -tokens);
      this.trades.push({ t: e.t, buy, eth: buy ? eth : eth + fee + tax, tokens, who: e.who, b: e.b });
    } else if (e.k === "grad") {
      this.graduated = true;
      this.v4 = { x: Number(e.pairAmount) / 1e18, y: Number(e.tokenAmount) / 1e18 };
    } else if (e.k === "swap" && this.v4) {
      // currency0 is native ETH (address 0 sorts first); amounts are the
      // swapper's deltas, so the pool moves the other way.
      const d0 = Number(e.a0) / 1e18;
      const d1 = Number(e.a1) / 1e18;
      const sqrtP = Number(BigInt(e.sqrtP)) / 2 ** 96;
      const L = Number(BigInt(e.L)) / 1e18;
      if (L > 0 && sqrtP > 0) this.v4 = { x: L / sqrtP, y: L * sqrtP };
      const buy = d1 > 0; // swapper received tokens
      const eth = Math.abs(d0);
      const tokens = Math.abs(d1);
      if (e.who) {
        if (buy && !this.firstBuyAt.has(e.who)) this.firstBuyAt.set(e.who, e.t);
        this._move(e.who, buy ? tokens : -tokens);
      }
      this.trades.push({ t: e.t, buy, eth, tokens, who: e.who ?? "?", b: e.b });
    }
    const p = this.price();
    if (p > this.highPrice) this.highPrice = p;
    const eh = this.earlyHeld();
    if (eh > this.earlyPeak) this.earlyPeak = eh;
  }

  _move(who, delta) {
    const v = (this.holders.get(who) ?? 0) + delta;
    this.holders.set(who, v);
    if (who === this.deployer) {
      if (delta < 0) this.devSold += -delta;
      this.devTokens = Math.max(0, v);
      if (this.devTokens > this.devPeak) this.devPeak = this.devTokens;
    }
  }

  /** The window of trades in (now - secs, now]. */
  window(now, secs) {
    const out = [];
    for (let i = this.trades.length - 1; i >= 0; i--) {
      const tr = this.trades[i];
      if (tr.t <= now - secs) break;
      if (tr.t <= now) out.push(tr);
    }
    return out.reverse();
  }

  /** Same-block buys of 3+ from distinct wallets read as one bundled actor. */
  _collapse(trades) {
    const out = [];
    for (const tr of trades) {
      const prev = out[out.length - 1];
      if (prev && prev.buy === tr.buy && prev.b === tr.b && tr.buy && (this.blockBuys.get(tr.b) ?? 0) >= 3) {
        prev.eth += tr.eth;
        continue;
      }
      out.push({ ...tr });
    }
    return out;
  }

  hawkes(now, secs = 300) {
    const tr = this._collapse(this.window(now, secs));
    if (tr.length < 6) return null;
    const m = marks(tr.map((x) => x.eth));
    const ev = tr.map((x, i) => ({ t: x.t, j: x.buy ? 0 : 1, m: m[i] }));
    return fitHawkes(ev, now - secs, now, { beta: BETA });
  }

  features(now) {
    const age = now - this.launchT;
    const w60 = this.window(now, 60);
    const prev60 = this.window(now - 60, 60);
    const buys60 = w60.filter((x) => x.buy);
    const sells60 = w60.filter((x) => !x.buy);
    const buyEth60 = buys60.reduce((s, x) => s + x.eth, 0);
    const sellEth60 = sells60.reduce((s, x) => s + x.eth, 0);
    let newBuyers180 = 0, newBuyersPrev180 = 0;
    for (const t of this.firstBuyAt.values()) {
      if (t > now - 180 && t <= now) newBuyers180++;
      else if (t > now - 360 && t <= now - 180) newBuyersPrev180++;
    }
    const recentBuys = this.trades.filter((x) => x.buy && x.t <= now).slice(-30);
    const med = (a) => (a.length ? [...a].sort((x, y) => x - y)[a.length >> 1] : 0);
    const sizeNow = med(recentBuys.slice(-15).map((x) => x.eth));
    const sizePrev = med(recentBuys.slice(0, -15).map((x) => x.eth));
    const { Q } = this.reserves();
    const sold = Math.max(1, this.t);
    const top = [...this.holders.entries()].filter(([, v]) => v > 0).map(([, v]) => v).sort((a, b) => b - a);
    const top10 = top.slice(0, 10).reduce((s, x) => s + x, 0) / sold;
    const earlyHeld = this.earlyHeld();
    const earlySells60 = this.window(now, 60).filter((x) => !x.buy && this.early.has(x.who));
    const earlySold60 = earlySells60.reduce((s, x) => s + x.tokens, 0);
    const earlySoldEth60 = earlySells60.reduce((s, x) => s + x.eth, 0);
    const largestSell60 = sells60.reduce((m, x) => Math.max(m, x.eth), 0);
    const vwap300 = (() => {
      const w = this.window(now, 300);
      const e = w.reduce((s, x) => s + x.eth, 0), k = w.reduce((s, x) => s + x.tokens, 0);
      return k > 0 ? e / k : this.price();
    })();
    return {
      age,
      price: this.price(),
      mcapEth: this.mcapEth(),
      progress: this.progress(),
      Q,
      buys60: buys60.length,
      buysPrev60: prev60.filter((x) => x.buy).length,
      buyEth60,
      sellEth60,
      er60: buyEth60 + sellEth60 > 0 ? buyEth60 / (buyEth60 + sellEth60) : 0.5,
      newBuyers180,
      newBuyersPrev180,
      sizeNow,
      sizePrev,
      top10,
      earlyShare: earlyHeld / sold, // what the launch cohort still holds
      earlyLeft: this.earlyPeak > 0 ? earlyHeld / this.earlyPeak : 0,
      earlySold60: earlyHeld + earlySold60 > 0 ? earlySold60 / (earlyHeld + earlySold60) : 0,
      earlyDumpPress: Q > 0 ? earlySoldEth60 / Q : 0, // the cohort's selling, against the curve's depth
      devShare: this.devTokens / sold,
      roundTrip: 2 * FEE + this.buyTax + this.sellTax,
      devLeft: this.devPeak > 0 ? this.devTokens / this.devPeak : 1,
      devSold: this.devSold,
      largestSell60: Q > 0 ? largestSell60 / Q : 0,
      sellPress60: Q > 0 ? sellEth60 / Q : 0,
      runup: vwap300 > 0 ? this.price() / vwap300 : 1,
      offHigh: this.highPrice > 0 ? this.price() / this.highPrice : 1,
      idle: now - (this.trades[this.trades.length - 1]?.t ?? this.launchT),
    };
  }
}
