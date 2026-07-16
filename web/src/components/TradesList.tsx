import { useTrades } from "@launchpad/sdk/react";
import type { Address } from "@launchpad/sdk";

import { client } from "../lib/client";
import { env } from "../lib/env";
import { explorerTx, fmtWei, fmtTokens, shortAddr, timeAgo } from "../lib/format";
import { EmptyState, Skeleton } from "./ui";

export function TradesList({ token, symbol }: { token: Address; symbol: string }) {
  const { trades, loading } = useTrades(client, token, 60);

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (trades.length === 0) {
    return <EmptyState title="No trades yet" body="Trades appear here in real time as they land on-chain." />;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="border-b border-edge text-[10px] uppercase tracking-wider text-ink-3">
            <th className="px-4 py-2 font-medium">Time</th>
            <th className="px-2 py-2 font-medium">Side</th>
            <th className="mono px-2 py-2 text-right font-medium">{env.nativeSymbol}</th>
            <th className="mono px-2 py-2 text-right font-medium">{symbol}</th>
            <th className="px-2 py-2 font-medium">Trader</th>
            <th className="px-4 py-2 text-right font-medium">Tx</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((t) => (
            <tr
              key={t.id}
              className={`border-b border-edge/50 ${t.isBuy ? "flash-up" : "flash-down"}`}
            >
              <td className="whitespace-nowrap px-4 py-2 text-ink-3">{timeAgo(t.timestamp)}</td>
              <td className={`px-2 py-2 font-semibold ${t.isBuy ? "text-up" : "text-down"}`}>
                {t.isBuy ? "Buy" : "Sell"}
              </td>
              <td className="mono px-2 py-2 text-right text-ink-2">{fmtWei(t.nativeAmountWei)}</td>
              <td className="mono px-2 py-2 text-right text-ink-2">{fmtTokens(t.tokenAmount)}</td>
              <td className="mono px-2 py-2 text-ink-3">{shortAddr(t.trader)}</td>
              <td className="px-4 py-2 text-right">
                {explorerTx(t.txHash) ? (
                  <a
                    href={explorerTx(t.txHash)!}
                    target="_blank"
                    rel="noreferrer"
                    className="font-medium text-ink underline underline-offset-2"
                  >
                    View
                  </a>
                ) : (
                  <span className="mono text-ink-3">{shortAddr(t.txHash)}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
