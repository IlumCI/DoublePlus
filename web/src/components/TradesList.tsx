import { useEffect, useMemo, useState } from "react";
import { useTrades } from "@launchpad/sdk/react";
import type { Address } from "@launchpad/sdk";

import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { explorerAddr, fmtUsd, fmtWei, fmtTokens, shortAddr } from "../lib/format";
import { EmptyState, Skeleton } from "./ui";

const PER_PAGE = 12;

export function TradesList({ token, symbol }: { token: Address; symbol: string }) {
  const { trades, loading } = useTrades(client, token, 120);
  const [scale, setScale] = useState(0);
  const [page, setPage] = useState(0);

  useEffect(() => {
    let live = true;
    v4Client.mcapScale(token).then((s) => live && setScale(s)).catch(() => undefined);
    return () => { live = false; };
  }, [token]);

  const pages = Math.max(1, Math.ceil(trades.length / PER_PAGE));
  const view = useMemo(() => trades.slice(page * PER_PAGE, page * PER_PAGE + PER_PAGE), [trades, page]);

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(6)].map((_, i) => <Skeleton key={i} className="h-8" />)}
      </div>
    );
  }
  if (trades.length === 0) {
    return <EmptyState title="No trades yet" body="Trades appear here in real time as they land on-chain." />;
  }

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[560px] text-left">
          <thead>
            <tr className="border-b border-edge text-[9.5px] uppercase tracking-wider text-ink-3">
              <th className="px-3 py-2 font-medium">Side</th>
              <th className="px-2 py-2 font-medium">{env.nativeSymbol}</th>
              <th className="px-2 py-2 font-medium">{symbol}</th>
              <th className="px-2 py-2 font-medium">Market cap</th>
              <th className="px-2 py-2 font-medium">Wallet</th>
              <th className="px-3 py-2 text-right font-medium">Time</th>
            </tr>
          </thead>
          <tbody>
            {view.map((t) => {
              const d = new Date(t.timestamp * 1000);
              const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
              const time = d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" });
              const mcap = scale ? fmtUsd((Number(t.priceWei) / 1e18) * scale) : "—";
              const explorer = explorerAddr(t.trader);
              return (
                <tr key={t.id} className="border-b border-edge/50 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2.5">
                    <span className="inline-flex items-center gap-1.5">
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${t.isBuy ? "bg-up/15 text-up" : "bg-down/15 text-down"}`}>
                        {t.isBuy ? "BUY" : "SELL"}
                      </span>
                      <span className="text-[9.5px] font-semibold text-ink-3">V4</span>
                    </span>
                  </td>
                  <td className="mono px-2 py-2.5 text-[12px] text-ink">{fmtWei(t.nativeAmountWei)}</td>
                  <td className="mono px-2 py-2.5 text-[12px] text-ink-2">{fmtTokens(t.tokenAmount)}</td>
                  <td className="mono px-2 py-2.5 text-[12px] text-ink">{mcap}</td>
                  <td className="px-2 py-2.5">
                    {explorer ? (
                      <a href={explorer} target="_blank" rel="noreferrer" className="mono text-[12px] text-ink-3 transition-colors hover:text-ink">
                        {shortAddr(t.trader)}
                      </a>
                    ) : (
                      <span className="mono text-[12px] text-ink-3">{shortAddr(t.trader)}</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right text-[11px] leading-tight text-ink-3">
                    {date} at<br />{time}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {pages > 1 ? (
        <div className="flex items-center justify-between border-t border-edge px-3 py-2.5">
          <button
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            disabled={page === 0}
            className="grid h-7 w-7 place-items-center rounded-md border border-edge text-ink-2 transition-colors hover:border-edge-2 hover:text-ink disabled:opacity-40"
            aria-label="Previous page"
          >
            ‹
          </button>
          <span className="text-[10.5px] font-semibold uppercase tracking-wider text-ink-3">Page {page + 1}</span>
          <button
            onClick={() => setPage((p) => Math.min(pages - 1, p + 1))}
            disabled={page >= pages - 1}
            className="grid h-7 w-7 place-items-center rounded-md border border-edge text-ink-2 transition-colors hover:border-edge-2 hover:text-ink disabled:opacity-40"
            aria-label="Next page"
          >
            ›
          </button>
        </div>
      ) : null}
    </div>
  );
}
