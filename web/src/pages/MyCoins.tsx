import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { Address, TokenSummary } from "@launchpad/sdk";

import { Button } from "../components/ui";
import { client, v4Client } from "../lib/client";
import { compact, fmtUsd } from "../lib/format";
import { tokenAbi } from "../lib/v4/abis";
import { stockOf } from "../lib/v4/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

interface Holding {
  t: TokenSummary;
  balance: bigint;
  valueUsd: number;
  pending: bigint;
}

/** The connected wallet's positions across every market it holds, with the
 *  tokenized stock rewards it has accrued and a one-tap claim. */
export function MyCoinsPage() {
  const { address, isConnected, connectFirst } = useWallet();
  const { data: tokens } = useTokens(client, { sort: "new", limit: 60 });
  const pushToast = useUi((s) => s.pushToast);
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useMemo(
    () => async () => {
      if (!isConnected || !address || !tokens || tokens.length === 0) {
        setHoldings([]);
        return;
      }
      const balCalls = tokens.map((t) => ({ address: t.address as Address, abi: tokenAbi, functionName: "balanceOf", args: [address] }));
      const rewCalls = tokens.map((t) => ({ address: t.address as Address, abi: tokenAbi, functionName: "pendingRewards", args: [address] }));
      const res = (await v4Client.publicClient.multicall({ allowFailure: true, contracts: [...balCalls, ...rewCalls] as any })) as any[];
      const n = tokens.length;
      const list: Holding[] = [];
      tokens.forEach((t, i) => {
        const bal = res[i]?.status === "success" ? (res[i].result as bigint) : 0n;
        const pending = res[n + i]?.status === "success" ? (res[n + i].result as bigint) : 0n;
        if (bal > 0n) {
          const valueUsd = (Number(bal) / 1e18) * Number(t.priceUsd || 0);
          list.push({ t, balance: bal, valueUsd, pending });
        }
      });
      list.sort((a, b) => b.valueUsd - a.valueUsd);
      setHoldings(list);
    },
    [isConnected, address, tokens],
  );

  useEffect(() => {
    load();
    const id = setInterval(load, 20_000);
    return () => clearInterval(id);
  }, [load]);

  const claim = async (h: Holding) => {
    setBusy(h.t.address);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await v4Client.claimDividends(h.t.address as Address);
      pushToast({ kind: "info", title: "Claim submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Rewards claimed", body: "Sent to your wallet.", txHash: hash });
      load();
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const total = holdings?.reduce((a, h) => a + h.valueUsd, 0) ?? 0;

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <h1 className="text-[20px] font-bold text-ink">My Coins</h1>
        <p className="mt-2 text-[14px] text-ink-2">Connect your wallet to see the markets you hold and the stocks you’ve earned.</p>
        <div className="mt-6"><Button onClick={connectFirst}>Connect wallet</Button></div>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-3xl px-4 pb-20 pt-5 sm:px-5">
      <div className="flex items-end justify-between">
        <h1 className="text-[16px] font-bold tracking-tight text-ink">My Coins</h1>
        <div className="text-right">
          <p className="text-[10.5px] text-ink-3">Portfolio value</p>
          <p className="mono text-[15px] font-bold text-ink">{fmtUsd(total)}</p>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-edge bg-panel/40">
        {holdings == null ? (
          <div className="space-y-2 p-3">
            {[...Array(3)].map((_, i) => <div key={i} className="h-14 animate-pulse rounded-xl bg-panel-2" />)}
          </div>
        ) : holdings.length === 0 ? (
          <div className="px-6 py-16 text-center">
            <p className="text-[15px] font-semibold text-ink">No coins yet</p>
            <p className="mt-1 text-[13.5px] text-ink-2">Buy into a market and it’ll show up here.</p>
            <Link to="/" className="mt-5 inline-block rounded-lg bg-accent px-4 py-2.5 text-[13.5px] font-semibold text-white hover:bg-accent-2">
              Discover markets
            </Link>
          </div>
        ) : (
          <div className="divide-y divide-edge">
            {holdings.map((h) => {
              const stock = stockOf((h.t.metadata as any)?.rewardStock);
              return (
                <div key={h.t.address} className="flex items-center gap-3 px-3 py-2.5 sm:px-4">
                  <Link to={`/token/${h.t.address}`} className="flex min-w-0 flex-1 items-center gap-2.5">
                    <span className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-edge bg-panel-2 text-[11px] font-bold text-ink-3">
                      {h.t.symbol.slice(0, 2).toUpperCase()}
                    </span>
                    <span className="min-w-0">
                      <span className="block truncate text-[14px] font-semibold text-ink">{h.t.name}</span>
                      <span className="mono block truncate text-[11.5px] text-ink-3">
                        {compact(Number(h.balance) / 1e18)} {h.t.symbol}
                      </span>
                    </span>
                  </Link>

                  <div className="hidden text-right sm:block">
                    <p className="mono text-[13.5px] font-semibold text-ink">{fmtUsd(h.valueUsd)}</p>
                    {stock ? <p className="text-[11px] text-ink-3">earns {stock.symbol}</p> : null}
                  </div>

                  {h.pending > 0n && stock ? (
                    <button
                      onClick={() => claim(h)}
                      disabled={busy === h.t.address}
                      className="shrink-0 rounded-lg bg-up px-3 py-1.5 text-[12.5px] font-semibold text-white transition-[filter] hover:brightness-110 disabled:opacity-60"
                    >
                      {busy === h.t.address ? "Claiming" : `Claim ${stock.symbol}`}
                    </button>
                  ) : (
                    <Link to={`/token/${h.t.address}`} className="shrink-0 rounded-lg border border-edge px-3 py-1.5 text-[12.5px] font-semibold text-ink-2 hover:border-edge-2 hover:text-ink">
                      Trade
                    </Link>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
