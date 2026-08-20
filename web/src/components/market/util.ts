import type { TokenSummary } from "@launchpad/sdk";

import { usdRateOf } from "../../lib/format";

/** USD price formatter tuned for token prices spanning $0.0000001 to $1000+. */
export function fmtPrice(usd: number): string {
  if (!isFinite(usd) || usd <= 0) return "$0";
  if (usd >= 1000) return `$${Math.round(usd).toLocaleString()}`;
  if (usd >= 1) return `$${usd.toFixed(2)}`;
  if (usd >= 0.01) return `$${usd.toFixed(4)}`;
  const s = usd.toFixed(12).replace(/0+$/, "");
  const m = s.match(/^0\.(0*)(\d{1,3})/);
  if (!m) return `$${usd.toPrecision(2)}`;
  return `$0.${m[1]}${m[2]}`;
}

export const volUsd = (t: TokenSummary): number =>
  (Number(t.volume24hWei || "0") / 1e18) * usdRateOf(t);

export const liqUsd = (t: TokenSummary): number =>
  (Number(t.liquidityWei || "0") / 1e18) * usdRateOf(t);

export interface MarketFilters {
  favOnly: boolean;
  officialOnly: boolean;
  hideZeroVol: boolean;
  minLiqUsd: number;
  minVolUsd: number;
}

export const EMPTY_FILTERS: MarketFilters = {
  favOnly: false,
  officialOnly: false,
  hideZeroVol: false,
  minLiqUsd: 0,
  minVolUsd: 0,
};

export const activeFilterCount = (f: MarketFilters): number =>
  [f.favOnly, f.officialOnly, f.hideZeroVol, f.minLiqUsd > 0, f.minVolUsd > 0].filter(Boolean).length;
