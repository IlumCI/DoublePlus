import { GUARANTEED, type RaiseMode } from "./raiseMode";

/** The curve quotes and trade-panel arithmetic, mirroring VentureFactory.
 *
 *  Kept apart from the RPC client so it stays pure and can be tested without a
 *  chain, in the same spirit as marketStats.ts. client.ts re-exports the quote
 *  functions, so existing imports are unaffected.
 *
 *  Every number here is shown to someone before they sign. The curve figures
 *  mirror the contract's own integral, so a mismatch means the quote in the
 *  panel is not the price the transaction pays.
 */

/** The subset of a Venture this module needs. Structural, so it takes the full
 *  `Venture` from client.ts without importing it and creating a cycle. */
export interface CurveState {
  mode: RaiseMode;
  basePriceWei: bigint;
  slopeQ: bigint;
  soldWhole: bigint;
  remainingWhole: bigint;
}

/** Integer square root by Newton's method — the same shape the contract uses. */
export function sqrtBig(n: bigint): bigint {
  if (n < 2n) return n;
  let x = n;
  let y = (x + 1n) / 2n;
  while (y < x) {
    x = y;
    y = (x + n / x) / 2n;
  }
  return x;
}

/** Exact integral cost of buying `qWhole` tokens starting from `fromSoldWhole`
 *  sold: q*p0 + k*(2Sq + q^2)/2, in Q18. Mirrors VentureFactory.curveCost. */
export function curveCostWei(v: CurveState, qWhole: bigint, fromSoldWhole: bigint): bigint {
  if (qWhole <= 0n) return 0n;
  return qWhole * v.basePriceWei
    + (v.slopeQ * (2n * fromSoldWhole * qWhole + qWhole * qWhole)) / (2n * 10n ** 18n);
}

/** Closed-form inverse of curveCostWei: whole tokens bought by `valueWei` from
 *  the current point. Path-independent, so splitting an order changes nothing.
 *  Mirrors VentureFactory.tokensForValue. */
export function quoteTokens(v: CurveState, valueWei: bigint): bigint {
  const k = v.slopeQ;
  if (valueWei <= 0n) return 0n;
  if (k === 0n) return v.basePriceWei > 0n ? valueWei / v.basePriceWei : 0n;
  const b = 10n ** 18n * v.basePriceWei + k * v.soldWhole;
  const disc = b * b + 2n * k * 10n ** 18n * valueWei;
  const q = (sqrtBig(disc) - b) / k;
  return q > v.remainingWhole ? v.remainingWhole : q;
}

/** What `qWhole` tokens are worth at the price the pool opens at when the
 *  curve fills: the closing price of a fully sold curve. Graduation seeds the
 *  pool at exactly that price, so this is the bag's value the moment trading
 *  opens, before anyone else trades. */
export const CURVE_SUPPLY_WHOLE = 600_000_000n;
export function gradValueWei(v: CurveState, qWhole: bigint): bigint {
  const endPrice = v.basePriceWei + (v.slopeQ * CURVE_SUPPLY_WHOLE) / 10n ** 18n;
  return qWhole * endPrice;
}

export interface SellQuote {
  gross: bigint;
  fee: bigint;
  out: bigint;
  /** True when the Guaranteed cap bound the payout below the curve price. */
  capped: boolean;
}

/** What selling `qWhole` back to the curve pays.
 *
 *  In Guaranteed mode the gross is capped at the seller's pro-rata cost basis.
 *  That is not a UX preference but the solvency constraint: refunds stay funded
 *  if and only if gross sell proceeds never exceed the basis of what was sold.
 *  Without it an early buyer can sell into later buyers' ETH at a profit and
 *  leave the escrow short of what the remaining backers are owed. */
export function quoteSellWei(
  v: CurveState,
  qWhole: bigint,
  ownedWei: bigint,
  basisWei: bigint,
  sellFeeBps: number,
  referred = false,
): SellQuote {
  if (qWhole <= 0n || ownedWei === 0n) return { gross: 0n, fee: 0n, out: 0n, capped: false };
  const q = qWhole > v.soldWhole ? v.soldWhole : qWhole;
  const raw = curveCostWei(v, q, v.soldWhole - q);
  const basis = (basisWei * (q * 10n ** 18n)) / ownedWei;
  const capped = v.mode === GUARANTEED && raw > basis;
  const gross = capped ? basis : raw;
  const fee = curveFeeWei(gross, sellFeeBps, referred);
  return { gross, fee, out: gross - fee, capped };
}

/** VentureFeeHook.REFEREE_DISCOUNT_BPS: a wallet with a bound referrer pays
 *  10% less of the curve fees, as it does of the platform fee after graduation. */
export const REFEREE_DISCOUNT_BPS = 1_000n;

/** A curve fee as VentureFactory._feeFor computes it. */
export function curveFeeWei(amountWei: bigint, bps: number, referred = false): bigint {
  const fee = (amountWei * BigInt(bps)) / 10_000n;
  return referred ? fee - (fee * REFEREE_DISCOUNT_BPS) / 10_000n : fee;
}

/** The protocol's curve entry fee, taken off the incoming value *before* the
 *  curve is quoted — so `spentWei` records what actually reached escrow and
 *  `sum(spentWei) == raisedWei` holds. Mirrors VentureFactory.buy. */
export function entryFeeWei(valueWei: bigint, buyFeeBps: number, referred = false): bigint {
  if (valueWei <= 0n) return 0n;
  return curveFeeWei(valueWei, buyFeeBps, referred);
}

/** What a buy of `valueWei` actually gets, fee first then curve. */
export function quoteBuy(v: CurveState, valueWei: bigint, buyFeeBps: number, referred = false): {
  fee: bigint;
  net: bigint;
  tokensOut: bigint;
} {
  const fee = entryFeeWei(valueWei, buyFeeBps, referred);
  const net = valueWei > fee ? valueWei - fee : 0n;
  return { fee, net, tokensOut: quoteTokens(v, net) };
}

/** Per-wallet cap state for the buy button. A cap of 0 means no cap, which is
 *  what an open curve stores (the factory uses type(uint256).max there). */
export function capState(maxBuyWei: bigint, alreadySpentWei: bigint, wantWei: bigint): {
  capLeft: bigint;
  overCap: boolean;
} {
  const capLeft = maxBuyWei > alreadySpentWei ? maxBuyWei - alreadySpentWei : 0n;
  return { capLeft, overCap: maxBuyWei > 0n && wantWei > capLeft };
}

/** Basis points as the percentage shown beside a trade. Two decimals, because
 *  the protocol fee is 0.55% and one decimal rounded it to a wrong 0.6%. */
export const feePct = (bps: number): string => (bps / 100).toFixed(2);

/** Founder tax, which is set in whole and half percents, so one decimal. */
export const taxPct = (bps: number): string => (bps / 100).toFixed(1);
