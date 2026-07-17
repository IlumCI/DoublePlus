const Q96 = 2n ** 96n;
const WAD = 10n ** 18n;

/**
 * Price of the launch token in native wei per whole token (1e18 base units),
 * derived from the pool's sqrtPriceX96 and the token0/token1 ordering.
 */
export function priceWeiFromSqrtPrice(sqrtPriceX96: bigint, tokenIsToken0: boolean): bigint {
  if (sqrtPriceX96 === 0n) return 0n;
  if (tokenIsToken0) {
    // price = (sqrtP^2 / 2^192) * 1e18
    return (((sqrtPriceX96 * sqrtPriceX96) / Q96) * WAD) / Q96;
  }
  // price = (2^192 / sqrtP^2) * 1e18
  return (Q96 * Q96 * WAD) / (sqrtPriceX96 * sqrtPriceX96);
}

/** wei bigint -> float ether (display precision only). */
export function weiToEth(wei: bigint): number {
  return Number(wei) / 1e18;
}

/** 8-decimal USD bigint -> decimal string. */
export function usd8ToString(value: bigint): string {
  const whole = value / 10n ** 8n;
  const frac = (value % 10n ** 8n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${whole}${frac ? "." + frac : ""}`;
}
