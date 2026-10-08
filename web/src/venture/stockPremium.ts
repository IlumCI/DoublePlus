/** Stock-token premiums: what a tokenized stock trades for in its on-chain
 *  pool against its Chainlink price. Pure, like marketStats.ts.
 *
 *  Supply only moves when authorised participants mint or burn, which they do
 *  on weekdays; the pools trade around the clock. So when the market is shut,
 *  a squeezed float can trade far from the last real price until the next
 *  mint closes the gap. */

export type MarketState = "regular" | "extended" | "closed";

/** US equities, in New York time: regular 9:30-16:00 Mon-Fri; Robinhood's
 *  24/5 session runs Sun 20:00 to Fri 20:00; everything else is the weekend
 *  gap. Holidays are not modelled. */
export function marketState(at: Date): MarketState {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at).map((p) => [p.type, p.value]),
  );
  const day = parts.weekday as string; // Sun..Sat
  const mins = Number(parts.hour) * 60 + Number(parts.minute);
  if (day === "Sat") return "closed";
  if (day === "Sun") return mins >= 20 * 60 ? "extended" : "closed";
  if (day === "Fri" && mins >= 20 * 60) return "closed";
  if (mins >= 9 * 60 + 30 && mins < 16 * 60) return "regular";
  return "extended";
}

/** Price of one stock token in USD from a V3 pool's sqrtPriceX96.
 *  quoteUsd is USD per whole quote token (USDG ~1, WETH = ETH/USD). */
export function poolPriceUsd(
  sqrtPriceX96: bigint, stockIsToken0: boolean, stockDecimals: number, quoteDecimals: number, quoteUsd: number,
): number {
  const s = Number(sqrtPriceX96) / 2 ** 96;
  const raw = s * s; // token1 per token0, raw units
  const oneForZero = raw * 10 ** ((stockIsToken0 ? stockDecimals : quoteDecimals) - (stockIsToken0 ? quoteDecimals : stockDecimals));
  const quotePerStock = stockIsToken0 ? oneForZero : 1 / oneForZero;
  return quotePerStock * quoteUsd;
}

export function premium(poolUsd: number, navUsd: number): number {
  return navUsd > 0 ? poolUsd / navUsd - 1 : 0;
}
