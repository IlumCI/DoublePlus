/** Live ETH/USD, with nothing hardcoded behind it. Coinbase, Kraken and
 *  Blockscout are asked at once; the median of whichever answer within the
 *  timeout is the price, so one stale or broken source can't move it. If none
 *  answer the result is 0, and callers show "—" or refuse to launch rather
 *  than fall back on a number that may be days old. */

const TIMEOUT_MS = 4_000;
const FRESH_MS = 60_000;
// A response outside this is a broken source, not the market.
const SANE: [number, number] = [100, 100_000];

type Source = { name: string; url: string; read: (j: any) => unknown };
const SOURCES: Source[] = [
  { name: "coinbase", url: "https://api.coinbase.com/v2/prices/ETH-USD/spot", read: (j) => j?.data?.amount },
  // Kraken keys the pair by its own name (XETHZUSD); c[0] is the last trade.
  { name: "kraken", url: "https://api.kraken.com/0/public/Ticker?pair=ETHUSD", read: (j) => (Object.values(j?.result ?? {})[0] as any)?.c?.[0] },
  // Robinhood Chain's own WETH; Blockscout's price for it tracks ETH.
  { name: "blockscout", url: "https://robinhoodchain.blockscout.com/api/v2/tokens/0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", read: (j) => j?.exchange_rate },
];

/** A source's reading as a usable price, or 0. */
export function sanePrice(raw: unknown): number {
  const v = Number(raw);
  return Number.isFinite(v) && v >= SANE[0] && v <= SANE[1] ? v : 0;
}

/** Median of the non-zero prices, or 0 when there are none. */
export function medianPrice(prices: number[]): number {
  const p = prices.filter((v) => v > 0).sort((a, b) => a - b);
  if (p.length === 0) return 0;
  const m = p.length >> 1;
  return p.length % 2 ? p[m] : (p[m - 1] + p[m]) / 2;
}

async function ask(s: Source): Promise<number> {
  try {
    const r = await fetch(s.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    return r.ok ? sanePrice(s.read(await r.json())) : 0;
  } catch {
    return 0;
  }
}

let cache: { at: number; usd: number } | null = null;
let inflight: Promise<number> | null = null;

/** ETH in USD from live sources, cached for a minute; 0 if none answered. */
export function liveEthUsd(): Promise<number> {
  if (cache && Date.now() - cache.at < FRESH_MS) return Promise.resolve(cache.usd);
  inflight ??= Promise.all(SOURCES.map(ask))
    .then(medianPrice)
    .then((usd) => {
      if (usd > 0) cache = { at: Date.now(), usd };
      return usd;
    })
    .finally(() => { inflight = null; });
  return inflight;
}
