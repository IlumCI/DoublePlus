// Reading the crowd: when a coin's buys start feeding on themselves, get in;
// when the launch cohort or the insiders are about to unload, get out first.
//
// Every number here is a knob in CONFIG so the bench can sweep it. Defaults
// are priors from docs/autotrader-research.md, not fitted values.

export const CONFIG = {
  // --- entry: a buy cascade forming (calibrated on the first 3 h of
  //     2026-10-08; see src/calibrate.mjs) ---
  minAge: 10, // s: past the snipe-tax seconds
  maxAge: 15 * 60, // runs start young; past ~25 min they mostly bleed
  maxProgress: 0.2, // the early curve: 44% ran, 6% dumped below 10%
  minBuys60: 3,
  minNewBuyers180: 4,
  minER60: 0.5,
  minNBB: 0.8, // buys feeding buys: the top fifth ran 44% of the time
  maxRunup: 1.2, // above this, waves came 34% of the time
  minEarlyShare: 0.02, // a launch cohort that has fully left means a dead coin
  minOffHigh: 0.8,
  entryScore: 1.0,
  // --- exit: sell into the wave before it breaks ---
  topRunup: 1.25, // vertical against the 5-min VWAP...
  topASB: 0.4, // ...and buys are setting off sells: profit-takers awake
  topGain: 1.15,
  sellWavePress: 0.1, // a minute's sells worth 10% of the curve's ETH
  sellWaveER: 0.5,
  wave1EarlySold60: 0.3, // the launch cohort dumping a third of its bag in a minute
  wave1MinEarlyShare: 0.1,
  devDumpLeft: 0.7, // dev has sold 30%+
  gradWaveProgress: 0.85, // sell into the graduation run
  fadeNBB: 0.2,
  fadeER: 0.4,
  idleSecs: 180,
  wrongRead: 0.7,
  maxHold: 30 * 60,
  trail: 0.65, // after a 1.8x, give back at most 35% from the high
  trailFrom: 1.8,
  // --- sizing ---
  maxImpact: 0.03, // a fill may move the curve at most ~3%
  maxPerCoin: 0.2, // of equity
  minTrade: 0.0015, // ETH
  maxPositions: 10,
};

/** Social read off the coin's own links: an X profile is something, a single
 *  post is less, nothing is nothing; a link reused across launches is a farm. */
export function socialScore(socials, reuse) {
  const s = (socials || "").toLowerCase();
  let score = 0;
  if (/x\.com|twitter\.com/.test(s)) score += /\/status\//.test(s) ? 0.3 : 0.6;
  if (/t\.me|telegram/.test(s)) score += 0.2;
  if (/discord/.test(s)) score += 0.1;
  if (/github\.com/.test(s)) score += 0.1;
  if (/https?:\/\/(?!x\.com|twitter\.com|t\.me|discord|github)/.test(s)) score += 0.2;
  if (reuse > 1) score -= 0.5;
  return Math.max(-0.5, Math.min(1, score));
}

/** Entry read. Returns { go, score, why } where why names the gate that failed. */
export function entrySignal(f, h, social, cfg = CONFIG) {
  if (f.age < cfg.minAge) return { go: false, why: "too-young" };
  if (f.age > cfg.maxAge) return { go: false, why: "too-old" };
  if (f.progress > cfg.maxProgress) return { go: false, why: "late" };
  if (f.buys60 < cfg.minBuys60) return { go: false, why: "quiet" };
  if (f.newBuyers180 < cfg.minNewBuyers180) return { go: false, why: "no-new-wallets" };
  if (f.er60 < cfg.minER60) return { go: false, why: "sellers-lead" };
  if (f.runup > cfg.maxRunup) return { go: false, why: "vertical" };
  if (f.offHigh < cfg.minOffHigh) return { go: false, why: "off-high" };
  if (f.earlyShare < cfg.minEarlyShare) return { go: false, why: "cohort-gone" };
  if (f.devLeft < cfg.devDumpLeft) return { go: false, why: "dev-sold" };
  if (!h) return { go: false, why: "no-fit" };
  if (h.nBB < cfg.minNBB) return { go: false, why: "not-self-exciting" };
  // Buys feeding buys, arrivals accelerating, a face on the coin.
  const accel = (f.newBuyers180 + 1) / (f.newBuyersPrev180 + 1);
  const score =
    0.8 * Math.min(h.nBB, 2) +
    0.3 * Math.log(Math.max(accel, 0.25)) +
    0.5 * (f.er60 - 0.5) +
    0.4 * social;
  return { go: score >= cfg.entryScore, score, why: score >= cfg.entryScore ? "cascade" : "weak" };
}

/** Exit read for a held position. Returns null to hold, or the wave it saw. */
export function exitSignal(f, h, pos, now, cfg = CONFIG) {
  const ret = f.price / pos.entryPrice;
  if (f.devLeft < cfg.devDumpLeft) return "dev-dump";
  // The top: price gone vertical and the buying now sets off selling.
  if (ret >= cfg.topGain && f.runup >= cfg.topRunup && h && h.alpha[1][0] >= cfg.topASB) return "wave-top";
  // Wave 1: the launch cohort unloading a real bag.
  if (f.earlySold60 >= cfg.wave1EarlySold60 && f.earlyShare >= cfg.wave1MinEarlyShare) return "wave1";
  // Wave 2 into graduation.
  if (f.progress >= cfg.gradWaveProgress) return "grad-wave";
  // A real sell wave, not jeets: heavy sells and sellers in charge.
  if (f.sellPress60 >= cfg.sellWavePress && f.er60 < cfg.sellWaveER) return "sell-wave";
  if (f.idle >= cfg.idleSecs) return "idle";
  if (h && h.nBB < cfg.fadeNBB && f.er60 < cfg.fadeER) return "faded";
  if (ret <= cfg.wrongRead) return "wrong-read";
  if (pos.high / pos.entryPrice >= cfg.trailFrom && f.price <= pos.high * cfg.trail) return "gave-back";
  if (now - pos.t >= cfg.maxHold) return "max-hold";
  return null;
}

/** How much ETH to put in: a slice of equity weighted by conviction, never
 *  more than the curve can take without moving it more than maxImpact. */
export function sizeFor(equity, cash, score, Q, cfg = CONFIG) {
  const weight = Math.min(1, Math.max(0.3, (score - cfg.entryScore) / 1.5 + 0.4));
  const byEquity = equity * cfg.maxPerCoin * weight;
  // Constant product: buying dq moves price by ~(1 + dq/Q)^2, so impact m
  // allows dq = Q * (sqrt(1+m) - 1).
  const byImpact = Q * (Math.sqrt(1 + cfg.maxImpact) - 1);
  const size = Math.min(byEquity, byImpact, cash);
  return size >= cfg.minTrade ? size : 0;
}
