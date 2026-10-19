/** Contract constants the UI needs before it can read a chain, in one place.
 *  Each is a `constant` in the venture contracts, so it only changes with a
 *  redeploy; protocol.test.ts fails if any of them drifts from the source. */

/** VentureFactory.TOTAL_SUPPLY, in whole tokens. */
export const TOTAL_SUPPLY = 1_000_000_000;
/** VentureFactory.CURVE_SUPPLY_WHOLE: whole tokens sold on the curve. */
export const CURVE_SUPPLY = 600_000_000;
/** VentureFactory.START_MCAP_USD_8 / 1e8: every curve opens at this market cap. */
export const START_FDV_USD = 750;
/** VentureFactory.MAX_RAISE_SECS in days. */
export const MAX_RAISE_DAYS = 14;
/** VentureFactory.LAUNCH_WINDOW_SECS: the first minute's 1%-of-target cap. */
export const LAUNCH_WINDOW_SECS = 60;
/** VentureFeeHook.REFEREE_DISCOUNT_BPS: a referred wallet's fee discount. */
export const REFEREE_DISCOUNT_BPS = 1_000;
