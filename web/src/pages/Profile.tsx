import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { Address, TokenSummary } from "@launchpad/sdk";

import { TokenLogo } from "../components/TokenLogo";
import { Button, EmptyState, Skeleton } from "../components/ui";
import { client, v4Client } from "../lib/client";
import { fmtUsd, fmtWei, shortAddr } from "../lib/format";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

const balAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

/** The connected wallet's corner: coins they launched (with unclaimed creator
 *  rewards and a claim), and every listed coin they hold. */
export function ProfilePage() {
  const { address, isConnected, connectFirst, disconnect } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const { data: tokens, loading } = useTokens(client, { sort: "new", limit: 80 });
  const [ethBal, setEthBal] = useState<bigint | null>(null);
  const [pending, setPending] = useState<Record<string, bigint>>({});
  const [holdings, setHoldings] = useState<Record<string, bigint>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const mine = (tokens ?? []).filter((t) => t.creator.toLowerCase() === address?.toLowerCase());

  useEffect(() => {
    if (!address) return;
    let live = true;
    client.publicClient.getBalance({ address: address as Address }).then((b) => live && setEthBal(b));
    return () => {
      live = false;
    };
  }, [address]);

  // Unclaimed deployer rewards per launched coin: 20% of the hook's base fee
  // buckets, coin side converted at the current price.
  useEffect(() => {
    if (!address || mine.length === 0) return;
    let live = true;
    const load = async () => {
      const next: Record<string, bigint> = {};
      for (const t of mine) {
        try {
          const f = (await (v4Client as any).pendingFees(t.address as Address)) as { coin: bigint; pair: bigint };
          const priceEthWei = BigInt((t as any).priceEthWei ?? "0");
          const coinAsEth = priceEthWei > 0n ? (f.coin * priceEthWei) / 10n ** 18n : 0n;
          next[t.address.toLowerCase()] = ((f.pair + coinAsEth) * 2_000n) / 10_000n;
        } catch {
          /* leave missing */
        }
      }
      if (live) setPending(next);
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, mine.length]);

  // Balances across every listed coin; only nonzero rows render.
  useEffect(() => {
    if (!address || !tokens || tokens.length === 0) return;
    let live = true;
    Promise.allSettled(
      tokens.map(async (t) => {
        const b = (await client.publicClient.readContract({
          address: t.address as Address,
          abi: balAbi,
          functionName: "balanceOf",
          args: [address as Address],
        })) as bigint;
        return [t.address.toLowerCase(), b] as const;
      }),
    ).then((rs) => {
      if (!live) return;
      const next: Record<string, bigint> = {};
      for (const r of rs) if (r.status === "fulfilled" && r.value[1] > 0n) next[r.value[0]] = r.value[1];
      setHoldings(next);
    });
    return () => {
      live = false;
    };
  }, [address, tokens]);

  const claim = async (t: TokenSummary) => {
    setBusy(t.address);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await (v4Client as any).harvest(t.address as Address);
      pushToast({ kind: "info", title: "Claim submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Rewards claimed", body: "Your fee stream, paid in ETH.", txHash: hash });
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  if (!isConnected) {
    return (
      <div className="mx-auto max-w-md px-4 py-24 text-center">
        <p className="text-[11px] uppercase tracking-wide text-ink-3">Profile</p>
        <h1 className="mt-2 text-xl font-bold text-ink">Connect your wallet</h1>
        <p className="mt-2 text-sm text-ink-2">See the coins you launched, your rewards, and your holdings.</p>
        <div className="mt-6">
          <Button variant="primary" onClick={connectFirst}>
            Connect Wallet
          </Button>
        </div>
      </div>
    );
  }

  const held = (tokens ?? []).filter((t) => holdings[t.address.toLowerCase()]);

  return (
    <div className="mx-auto max-w-lg px-4 pb-28 pt-5 sm:px-5">
      {/* Wallet card */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-3">
        <div>
          <h1 className="text-[16px] font-extrabold tracking-tight text-ink">Profile</h1>
          <p className="mt-0.5 font-mono text-[12px] text-ink-2">{shortAddr(address!)}</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="tnum text-[15px] font-semibold text-ink">{ethBal !== null ? `${fmtWei(ethBal)} ETH` : "–"}</p>
            <p className="text-[11px] text-ink-3">balance</p>
          </div>
          <Button variant="ghost" onClick={() => disconnect()}>
            Disconnect
          </Button>
        </div>
      </div>

      {/* Trader rewards: weekly flywheel claims */}
      <h2 className="mt-6 text-[13px] font-extrabold uppercase tracking-wide text-ink-2">Trader rewards</h2>
      <TraderRewards />

      {/* Launched coins */}
      <h2 className="mt-6 text-[13px] font-extrabold uppercase tracking-wide text-ink-2">Your coins</h2>
      {loading ? (
        <Skeleton className="mt-2 h-16" />
      ) : mine.length === 0 ? (
        <div className="mt-2 rounded-xl border border-edge bg-panel px-4 py-4 text-sm text-ink-2">
          You have not launched a coin yet.{" "}
          <Link to="/launch" className="font-semibold text-accent-ink underline underline-offset-2">
            Launch one
          </Link>{" "}
          and earn a fee stream in ETH for the life of the coin.
        </div>
      ) : (
        <div className="mt-2 space-y-2">
          {mine.map((t) => {
            const p = pending[t.address.toLowerCase()] ?? 0n;
            return (
              <div key={t.address} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5">
                <Link to={`/token/${t.address}`} className="flex min-w-0 items-center gap-2.5">
                  <TokenLogo token={t} size={30} />
                  <span className="min-w-0">
                    <span className="text-[13.5px] font-bold text-ink">${t.symbol}</span>
                    <span className="block truncate text-[11px] text-ink-3">{fmtUsd(t.marketCapUsd)} mcap</span>
                  </span>
                </Link>
                <div className="flex items-center gap-2.5">
                  <div className="text-right">
                    <p className="tnum text-[13.5px] font-semibold text-ink">{fmtWei(p)} ETH</p>
                    <p className="text-[10.5px] text-ink-3">unclaimed</p>
                  </div>
                  <Button variant="primary" disabled={busy !== null || p === 0n} onClick={() => claim(t)}>
                    {busy === t.address ? "Claiming" : "Claim"}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Holdings */}
      <h2 className="mt-6 text-[13px] font-extrabold uppercase tracking-wide text-ink-2">Your holdings</h2>
      {loading ? (
        <Skeleton className="mt-2 h-16" />
      ) : held.length === 0 ? (
        <EmptyState title="No coins held" body="Buy a coin on the board and it will show up here." />
      ) : (
        <div className="mt-2 space-y-2">
          {held.map((t) => {
            const bal = holdings[t.address.toLowerCase()]!;
            const amount = Number(bal) / 1e18;
            const usd = amount * Number(t.priceUsd || 0);
            return (
              <Link
                key={t.address}
                to={`/token/${t.address}`}
                className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5"
              >
                <span className="flex min-w-0 items-center gap-2.5">
                  <TokenLogo token={t} size={30} />
                  <span className="min-w-0">
                    <span className="text-[13.5px] font-bold text-ink">${t.symbol}</span>
                    <span className="block truncate text-[11px] text-ink-3">{t.name}</span>
                  </span>
                </span>
                <span className="text-right">
                  <span className="tnum block text-[13.5px] font-semibold text-ink">
                    {amount >= 1e6 ? `${(amount / 1e6).toFixed(2)}M` : amount.toLocaleString(undefined, { maximumFractionDigits: 0 })}
                  </span>
                  <span className="tnum block text-[10.5px] text-ink-3">{usd > 0 ? fmtUsd(usd) : ""}</span>
                </span>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}


/** Weekly flywheel: 30% of every fee pools per epoch; traders claim their
 *  pro-rata WETH share once the week closes. Shows the last few epochs. */
function TraderRewards() {
  const { address } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [rows, setRows] = useState<{ epoch: bigint; amount: bigint }[]>([]);
  const [busy, setBusy] = useState<string | null>(null);

  const hookAddr = (v4Client as any).v4.hook as Address;
  const abi = [
    { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
    { type: "function", name: "traderClaimable", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "traderVol", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "totalTraderVol", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
    { type: "function", name: "traderPot", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  ] as const;

  const [week, setWeek] = useState<{ vol: bigint; projected: bigint } | null>(null);
  const load = async () => {
    if (!address) return;
    try {
      const cur = (await client.publicClient.readContract({ address: hookAddr, abi, functionName: "currentEpoch" })) as bigint;
      const [myVol, totVol, pot] = await Promise.all([
        client.publicClient.readContract({ address: hookAddr, abi, functionName: "traderVol", args: [cur, address as Address] }) as Promise<bigint>,
        client.publicClient.readContract({ address: hookAddr, abi, functionName: "totalTraderVol", args: [cur] }) as Promise<bigint>,
        client.publicClient.readContract({ address: hookAddr, abi, functionName: "traderPot", args: [cur] }) as Promise<bigint>,
      ]);
      setWeek(myVol > 0n && totVol > 0n ? { vol: myVol, projected: (pot * myVol) / totVol } : null);
      const out: { epoch: bigint; amount: bigint }[] = [];
      for (let e = cur - 1n; e >= 0n && e >= cur - 4n; e--) {
        const amt = (await client.publicClient.readContract({ address: hookAddr, abi, functionName: "traderClaimable", args: [e, address as Address] })) as bigint;
        if (amt > 0n) out.push({ epoch: e, amount: amt });
        if (e === 0n) break;
      }
      setRows(out);
    } catch {
      /* pre-flywheel deployments */
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address]);

  const claim = async (epoch: bigint) => {
    setBusy(String(epoch));
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await (v4Client as any).claimTrader(epoch);
      pushToast({ kind: "info", title: "Claim submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "WETH claimed", body: "Your trading share, sent to your wallet.", txHash: hash });
      load();
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const weekRow = week ? (
    <div className="mt-2 flex items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.04] px-3.5 py-2.5">
      <div>
        <p className="text-[13.5px] font-bold text-ink">This week, so far</p>
        <p className="text-[11px] text-ink-3">{fmtWei(week.vol)} ETH volume routed by you</p>
      </div>
      <div className="text-right">
        <p className="tnum text-[13.5px] font-semibold text-ink">&asymp; {fmtWei(week.projected)} WETH</p>
        <p className="text-[10.5px] text-ink-3">projected share, grows with the pot</p>
      </div>
    </div>
  ) : null;

  if (rows.length === 0) {
    return (
      <>
        {weekRow}
        <div className="mt-2 rounded-xl border border-edge bg-panel px-4 py-4 text-sm text-ink-2">
          Trade any coin and 30% of the fees pool for traders like you; your pro-rata WETH share
          becomes claimable here when the week closes.
        </div>
      </>
    );
  }
  return (
    <div className="mt-2 space-y-2">
      {weekRow}
      {rows.map((r) => (
        <div key={String(r.epoch)} className="flex items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-3.5 py-2.5">
          <div>
            <p className="text-[13.5px] font-bold text-ink">Week {String(r.epoch)}</p>
            <p className="text-[11px] text-ink-3">your trading share</p>
          </div>
          <div className="flex items-center gap-2.5">
            <p className="tnum text-[13.5px] font-semibold text-ink">{fmtWei(r.amount)} WETH</p>
            <Button variant="primary" disabled={busy !== null} onClick={() => claim(r.epoch)}>
              {busy === String(r.epoch) ? "Claiming" : "Claim"}
            </Button>
          </div>
        </div>
      ))}
    </div>
  );
}
