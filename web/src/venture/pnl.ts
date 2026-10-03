import { quoteSellWei, type CurveState } from "./curve";

/**
 * Per-coin position arithmetic for the portfolio: what a wallet put in, what
 * it took out, what it could get out right now, and the difference. Pure, so
 * it is tested without a chain; the caller reads the logs and balances.
 *
 * "Put in" and "taken out" count every leg with ETH on it: curve buys and
 * sells, and router buys and sells after graduation. The curve's entry fee is
 * not in the CurveBuy amount, so a curve position reads slightly better than
 * the wallet's true cost, by 0.5% of what went in.
 */

export interface Flows {
  curveIn: bigint;   // sum of CurveBuy.ethIn
  curveOut: bigint;  // sum of CurveSell.ethOut
  routerIn: bigint;  // sum of Routed.ethIn on buys
  routerOut: bigint; // sum of Routed.ethOut on sells
}

export interface Position {
  putIn: bigint;
  takenOut: bigint;
  /** What the wallet could get out now, in wei; null when it cannot be priced. */
  valueNow: bigint | null;
  /** valueNow + takenOut - putIn; null when valueNow is unknown or nothing went in. */
  pnl: bigint | null;
  /** pnl as a percentage of putIn. */
  pnlPct: number | null;
  /** How valueNow was arrived at, in words a trader reads. */
  basis: "curve" | "refund" | "market" | "none";
}

export function position(flows: Flows, valueNow: bigint | null, basis: Position["basis"]): Position {
  const putIn = flows.curveIn + flows.routerIn;
  const takenOut = flows.curveOut + flows.routerOut;
  if (valueNow === null || putIn === 0n) return { putIn, takenOut, valueNow, pnl: null, pnlPct: null, basis };
  const pnl = valueNow + takenOut - putIn;
  return { putIn, takenOut, valueNow, pnl, pnlPct: (Number(pnl) / Number(putIn)) * 100, basis };
}

/** Before graduation: what selling the whole curve position back pays now,
 *  after the exit fee. In a refund raise this never exceeds what went in. */
export function curveValue(v: CurveState, boughtWei: bigint, spentWei: bigint, sellFeeBps: number): bigint {
  const whole = boughtWei / 10n ** 18n;
  if (whole === 0n) return 0n;
  return quoteSellWei(v, whole, boughtWei, spentWei, sellFeeBps).out;
}

/** After graduation: the coin balance at the pool's current price, less the
 *  sell-side fees (founder sell tax plus the protocol fee). It ignores price
 *  impact, so a position that is large against the pool would get less.
 *  `tick` is the pool's current tick; `coinIsC0` its token ordering. */
export function marketValue(balanceWei: bigint, tick: number, coinIsC0: boolean, sellFeeBps: number): bigint {
  // price of currency0 in currency1 = 1.0001^tick
  const p01 = Math.pow(1.0001, tick);
  const pairPerCoin = coinIsC0 ? p01 : 1 / p01;
  if (!Number.isFinite(pairPerCoin) || pairPerCoin <= 0) return 0n;
  // Scale through 1e12 to keep float precision on 18-decimal amounts.
  const scaled = BigInt(Math.floor(pairPerCoin * 1e12));
  const gross = (balanceWei * scaled) / 10n ** 12n;
  return (gross * BigInt(10_000 - sellFeeBps)) / 10_000n;
}
