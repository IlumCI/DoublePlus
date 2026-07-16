import { useHolders } from "@launchpad/sdk/react";
import type { Address, TokenSummary } from "@launchpad/sdk";

import { client } from "../lib/client";
import { explorerAddr, fmtTokens, shortAddr } from "../lib/format";
import { Badge, EmptyState, Skeleton } from "./ui";

export function HoldersList({ token }: { token: TokenSummary }) {
  const { data: holders, loading } = useHolders(client, token.address as Address, 50);

  if (loading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(5)].map((_, i) => (
          <Skeleton key={i} className="h-8" />
        ))}
      </div>
    );
  }
  if (!holders || holders.length === 0) {
    return <EmptyState title="No holders indexed yet" />;
  }

  const label = (addr: string) => {
    if (addr === token.pool) return <Badge tone="accent">Pool</Badge>;
    if (addr === token.creator) return <Badge tone="amber">Creator</Badge>;
    return null;
  };

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-xs">
        <thead className="sticky top-0 z-10 bg-panel">
          <tr className="border-b border-edge text-[10px] uppercase tracking-wider text-ink-3">
            <th className="px-4 py-2 font-medium">#</th>
            <th className="px-2 py-2 font-medium">Holder</th>
            <th className="mono px-2 py-2 text-right font-medium">Balance</th>
            <th className="px-4 py-2 text-right font-medium">Share</th>
          </tr>
        </thead>
        <tbody>
          {holders.map((h, i) => (
            <tr key={h.address} className="border-b border-edge/50">
              <td className="mono px-4 py-2 text-ink-3">{i + 1}</td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-2">
                  {explorerAddr(h.address) ? (
                    <a
                      href={explorerAddr(h.address)!}
                      target="_blank"
                      rel="noreferrer"
                      className="mono text-ink underline-offset-2 hover:underline"
                    >
                      {shortAddr(h.address)}
                    </a>
                  ) : (
                    <span className="mono text-ink-2">{shortAddr(h.address)}</span>
                  )}
                  {label(h.address)}
                </span>
              </td>
              <td className="mono px-2 py-2 text-right text-ink-2">{fmtTokens(h.balance)}</td>
              <td className="px-4 py-2">
                <div className="flex items-center justify-end gap-2">
                  <div className="h-1 w-16 overflow-hidden rounded-full bg-panel-2">
                    <div
                      className="h-full rounded-full bg-accent/70"
                      style={{ width: `${Math.min(h.pct, 100)}%` }}
                    />
                  </div>
                  <span className="mono w-14 text-right text-ink-2">{h.pct.toFixed(2)}%</span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
