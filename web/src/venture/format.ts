/** Pure number formatting. Kept out of ui.tsx because that module reaches the
 *  chain client, and a formatter should be testable without an RPC env. */

const SUBSCRIPT = "\u2080\u2081\u2082\u2083\u2084\u2085\u2086\u2087\u2088\u2089";
const subscript = (n: number): string => String(n).split("").map((d) => SUBSCRIPT[Number(d)]).join("");

/** A token price, which is not the same problem as a token's market cap.
 *
 *  Fixed 4dp renders a day-zero token at $0.0000 — and renders a token worth
 *  a tenth of it as the identical string, so the headline number carries no
 *  information exactly where a trader needs it most. Below a thousandth of a
 *  dollar this switches to the leading-zero-count form every major screener
 *  uses, so $0.0000318 reads $0.0\u2084318: four zeros, then the digits. */
export const fmtUsdPrice = (v: number): string => {
  if (!Number.isFinite(v) || v <= 0) return "$0";
  if (v >= 1) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  if (v >= 0.01) return `$${v.toFixed(4)}`;
  if (v >= 0.001) return `$${v.toFixed(6)}`;
  const exp = Math.floor(Math.log10(v));
  let zeros = -exp - 1;
  let digits = Math.round(v * 10 ** (-exp + 3)); // four significant figures
  // Rounding can carry into an extra digit (9.9999e-5 -> 10000), which is one
  // fewer leading zero, not a five-digit mantissa.
  if (digits >= 10_000) { digits = Math.round(digits / 10); zeros -= 1; }
  return `$0.0${subscript(zeros)}${digits}`;
};


/** Chart interval choice, as seconds per bar.
 *
 *  A fixed default cannot serve both a pool minutes old and one weeks old: the
 *  first draws a single candle at 5m, the second an unreadable ribbon at 1m.
 *  The rule is to prefer resolution and cap readability — take the finest
 *  interval whose bar count still fits `maxBars`, and when even the coarsest
 *  overflows, use that.
 *
 *  It cannot rescue a pool whose whole history is shorter than the finest
 *  interval: a minute of trading is one candle at 1m, which is the honest
 *  picture rather than a bug to format away. */
export function pickInterval(spanSecs: number, intervals: readonly number[], maxBars = 300): number {
  const sorted = [...intervals].sort((a, b) => a - b);
  if (sorted.length === 0) return 60;
  if (!(spanSecs > 0)) return sorted[0];
  return sorted.find((secs) => spanSecs / secs <= maxBars) ?? sorted[sorted.length - 1];
}
