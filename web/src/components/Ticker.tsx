import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";

import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtPct, fmtUsd } from "../lib/format";
import { stockOf } from "../lib/v4/stocks";

/**
 * A slow scrolling market tape under the header — every live market with its
 * price, 24h move and the stock it pays. Pauses on hover. Purely ambient, so
 * it renders nothing until there's data.
 */
export function Ticker() {
  const { data } = useTokens(client, { sort: "volume", limit: 30 });
  if (env.hideTokens || !data || data.length === 0) return null;

  const items = data;
  const row = [...items, ...items]; // duplicate for a seamless loop

  return (
    <div className="overflow-hidden border-b border-edge bg-panel/60">
      <div className="tape flex w-max items-center gap-6 py-1.5 pl-4 will-change-transform">
        {row.map((t, i) => {
          const change = t.priceChange24hPct;
          const stock = stockOf((t.metadata as any)?.rewardStock);
          return (
            <Link
              key={`${t.address}-${i}`}
              to={`/token/${t.address}`}
              className="flex shrink-0 items-center gap-1.5 text-[11.5px]"
            >
              <span className="font-semibold text-ink">{t.symbol}</span>
              <span className="mono text-ink-2">{fmtUsd(t.marketCapUsd)}</span>
              <span className={`mono ${change == null ? "text-ink-3" : change >= 0 ? "text-up" : "text-down"}`}>
                {change == null ? "—" : fmtPct(change)}
              </span>
              {stock ? <span className="text-ink-3">· {stock.symbol}</span> : null}
              <span className="ml-4 h-3 w-px bg-edge-2" />
            </Link>
          );
        })}
      </div>
    </div>
  );
}
