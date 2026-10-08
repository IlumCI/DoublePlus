// Synthetic Pons markets for stress tests: events shaped exactly like the
// fetcher's, priced on the real curve maths.
const WEI = 1e18;
const w = (x) => BigInt(Math.round(x * WEI)).toString();

export class SynthCoin {
  constructor(token, t0, { G = 4.2, tax = 0.01, deployer = "0xdev", socials = "https://x.com/real" } = {}) {
    this.token = token;
    this.Q = 0.4 * G;
    this.T = 1e9;
    this.tax = tax;
    this.events = [];
    this.b = Math.round(t0 * 10);
    this.events.push({ k: "launch", t: t0, b: this.b, li: 0, token, curve: token + "c", deployer, pair: "0x0000000000000000000000000000000000000000", gradQuote: w(G), socials });
    this.held = new Map();
  }
  buy(t, who, eth, b) {
    const fee = eth * 0.01, tax = eth * this.tax;
    const net = eth - fee - tax;
    const tokens = (this.T * net) / (this.Q + net);
    this.Q += net; this.T -= tokens;
    this.held.set(who, (this.held.get(who) ?? 0) + tokens);
    this.events.push({ k: "buy", t, b: b ?? Math.round(t * 10), li: this.events.length, token: this.token, who, quote: w(eth), tokens: w(tokens), fee: w(fee), tax: w(tax) });
    return tokens;
  }
  sell(t, who, tokens, b) {
    tokens = Math.min(tokens, this.held.get(who) ?? 0);
    if (tokens <= 0) return 0;
    const gross = (this.Q * tokens) / (this.T + tokens);
    const fee = gross * 0.01, tax = gross * this.tax;
    this.Q -= gross; this.T += tokens;
    this.held.set(who, this.held.get(who) - tokens);
    this.events.push({ k: "sell", t, b: b ?? Math.round(t * 10), li: this.events.length, token: this.token, who, quote: w(gross - fee - tax), tokens: w(tokens), fee: w(fee), tax: w(tax) });
    return gross - fee - tax;
  }
  sellAll(t, who) {
    return this.sell(t, who, this.held.get(who) ?? 0);
  }
  price() {
    return this.Q / this.T;
  }
}

export function lcg(seed) {
  let s = seed >>> 0;
  return () => ((s = (1664525 * s + 1013904223) >>> 0) / 2 ** 32);
}

/** An organic cascade: a widening crowd of distinct wallets, buys arriving
 *  faster and faster, varied sizes, a few jeets taking small profits. */
export function organic(c, t0, secs, rand, { start = 0.05, end = 0.6, jeets = 0.15, size = 0.02 } = {}) {
  let t = t0, n = 0;
  while (t < t0 + secs) {
    const rate = start + (end - start) * ((t - t0) / secs);
    t += -Math.log(1 - rand()) / rate;
    const who = `0xorg${n++}`;
    c.buy(t, who, 0.002 + size * rand() ** 2 * 2);
    if (rand() < jeets && n > 5) {
      const j = `0xorg${Math.floor(rand() * (n - 1))}`;
      c.sell(t + 0.3, j, (c.held.get(j) ?? 0) * 0.5);
    }
  }
  return t;
}

/** Merge several coins' events into one time-ordered stream. */
export function stream(...coins) {
  return coins.flatMap((c) => c.events).sort((a, b) => a.t - b.t || a.li - b.li);
}
