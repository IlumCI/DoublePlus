import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWalletClient } from "wagmi";

import {
  ercAbi, factoryAbi, loadReferralEarnings, updatesAbi, VENTURE, venturePc, vestingAbi,
} from "./client";
import { loadPortfolio, type Holding } from "./portfolio";
import { fmtEth, fmtTok, pct, short } from "./ui";
import { usePageMeta } from "./seo";
import { refLink } from "./referral";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

/** My desk: everything this wallet is owed across the launchpad — backed
 *  raises, holdings and dividends, referral earnings, founder tooling. */
export function Desk() {
  usePageMeta("Portfolio");
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [rows, setRows] = useState<Holding[] | null>(null);
  const [refEarned, setRefEarned] = useState<Map<string, bigint>>(new Map());
  // ETH credited to this wallet inside the factory: a founder's cut of a
  // graduated raise, referral shares of curve fees, and an Open-mode creator's
  // share of curve fees. Nothing pushes it; it waits for withdrawFees().
  const [factoryOwed, setFactoryOwed] = useState(0n);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = async () => {
      try {
        const sellBps = Number(await venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "curveSellFeeBps" }).catch(() => 100));
        const p = await loadPortfolio(me, sellBps);
        if (live) { setRows(p.rows); setFactoryOwed(p.factoryOwed); }
        const earned = await loadReferralEarnings(me);
        if (live) setRefEarned(earned);
      } catch {
        if (live) setRows([]);
      }
    };
    refresh();
    const id = setInterval(refresh, 20_000);
    return () => { live = false; clearInterval(id); };
  }, [me, busy]);

  if (!isConnected) {
    return (
      <div className="dp-shell" style={{ paddingBottom: 60 }}>
        <div className="dp-page-head">
          <h1 className="dp-page-title">Portfolio</h1>
          <p style={{ maxWidth: "56ch", color: "var(--dim)", fontSize: 13.5 }}>
            Connect a wallet to see your coins, what they're worth, and anything you can collect.
          </p>
          <button className="dp-action" style={{ marginTop: 14 }} onClick={connectFirst}>Connect wallet</button>
        </div>
      </div>
    );
  }

  const claimAll = async () => {
    if (!wc || !rows) return;
    setBusy(true);
    try {
      for (const r of rows) {
        if (r.pending > 0n) {
          const hash = await wc.writeContract({ address: r.v.address, abi: ercAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
          await venturePc.waitForTransactionReceipt({ hash });
        }
      }
      pushToast({ kind: "success", title: "Payouts claimed" });
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const withdrawOwed = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "withdrawFees", args: [], chain: wc.chain, account: wc.account });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${fmtEth(factoryOwed, 6)} ETH withdrawn`, txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Withdraw failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  /** Get a failed raise's ETH back in one go: close the round if nobody has,
   *  approve the tokens if needed, refund. */
  const refund = async (r: Holding) => {
    if (!wc) return;
    setBusy(true);
    try {
      const send = async (fn: "abort" | "refund") => {
        const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn, args: [r.v.address], chain: wc.chain, account: wc.account });
        await venturePc.waitForTransactionReceipt({ hash });
        return hash;
      };
      if (!r.v.aborted) await send("abort");
      const allowance = (await venturePc.readContract({ address: r.v.address, abi: ercAbi, functionName: "allowance", args: [me!, VENTURE.factory] })) as bigint;
      if (allowance < r.bought) {
        const a = await wc.writeContract({ address: r.v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.factory, r.bought], chain: wc.chain, account: wc.account });
        await venturePc.waitForTransactionReceipt({ hash: a });
      }
      const hash = await send("refund");
      pushToast({ kind: "success", title: `${fmtEth(r.refundable, 5)} ETH refunded`, txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Refund failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const claimVest = async (r: Holding) => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: r.v.vesting, abi: vestingAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `Vested $${r.v.symbol} claimed`, txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const postUpdate = async (r: Holding) => {
    const text = prompt(`Post an update for ${r.v.name} (on-chain, public):`);
    if (!text || !wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.updates, abi: updatesAbi, functionName: "postUpdate", args: [r.v.address, text], chain: wc.chain, account: wc.account });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Update posted on-chain", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Post failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const totalPending = (rows ?? []).reduce((a, r) => a + r.pending, 0n);
  const wethEarned = refEarned.get(VENTURE.weth.toLowerCase()) ?? 0n;
  const otherEarned = [...refEarned.entries()].filter(([c]) => c !== VENTURE.weth.toLowerCase());
  const founderRows = (rows ?? []).filter((r) => r.v.creator.toLowerCase() === me!.toLowerCase());

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Portfolio</h1>
        <p style={{ maxWidth: "62ch", color: "var(--dim)", fontSize: 13 }}>
          Holder payouts above a small minimum are sent to your wallet automatically, about every 15 minutes.
          Claim them here if you want them sooner.
        </p>
      </div>

      <div className="dp-owed">
        <span>Payouts to claim <b>{fmtEth(totalPending, 6)} ETH</b></span>
        <span>Referral earnings <b>{fmtEth(wethEarned, 6)} ETH</b></span>
        {factoryOwed > 0n && (
          <span title="Your cut of graduated raises and your share of curve fees. Only this wallet can withdraw it.">
            Ready to withdraw <b>{fmtEth(factoryOwed, 6)} ETH</b>{" "}
            <button className="dp-action" style={{ padding: "4px 12px", fontSize: 12 }} onClick={withdrawOwed} disabled={busy}>Withdraw</button>
          </span>
        )}
      </div>

      <div className="dp-two-col" style={{ marginTop: 16, alignItems: "start" }}>
        <div className="dp-form-sheet">
          <p className="dp-sec">Your coins <span className="dp-agate">in ETH; "worth now" is what selling would get you</span></p>
          {rows === null ? (
            <p className="dp-agate">Loading…</p>
          ) : rows.length === 0 ? (
            <p className="dp-agate">No coins yet.</p>
          ) : (
            <table className="dp-docket">
              <thead><tr><th>Coin</th><th className="dp-num">Put in</th><th className="dp-num">Worth now</th><th className="dp-num">P&amp;L</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.v.address}>
                    <td>
                      <Link className="dp-row-link" to={`/venture/${r.v.address}`} viewTransition>
                        <b>{r.v.name}</b> <span className="dp-mono" style={{ fontSize: 10.5 }}>${r.v.symbol}</span>
                      </Link>
                    </td>
                    <td className="dp-num">{r.pos.putIn > 0n ? fmtEth(r.pos.putIn, 4) : "—"}</td>
                    <td className="dp-num" title={r.pos.basis === "market" ? "At the pool price, after sell fees, before price impact" : r.pos.basis === "curve" ? "What the curve pays if you exit now" : undefined}>
                      {r.pos.valueNow !== null && (r.pos.valueNow > 0n || r.pos.putIn > 0n) ? fmtEth(r.pos.valueNow, 4) : "—"}
                    </td>
                    <td className="dp-num" style={{ color: r.pos.pnl === null ? undefined : r.pos.pnl >= 0n ? "var(--up)" : "var(--down)" }}>
                      {r.pos.pnl === null || r.pos.pnlPct === null ? "—" : `${r.pos.pnl >= 0n ? "+" : ""}${r.pos.pnlPct.toFixed(Math.abs(r.pos.pnlPct) < 10 ? 1 : 0)}%`}
                    </td>
                    <td>
                      {r.refundable > 0n ? (
                        <button className="dp-action" style={{ padding: "4px 10px", fontSize: 11 }} disabled={busy} onClick={() => refund(r)}>
                          Get {fmtEth(r.refundable, 4)} ETH back
                        </button>
                      ) : (
                        <span className={`dp-badge ${r.v.phase === "graduated" ? "dp-grad" : r.v.phase === "failed" ? "dp-dead" : "dp-live"}`}>
                          {r.v.phase === "graduated" ? "trading" : r.v.phase === "failed" ? "failed" : r.v.phase === "expired" ? "funded" : "filling"}
                        </span>
                      )}
                      {r.pending > 0n && <span className="dp-mono" style={{ fontSize: 10.5, color: "var(--up)", marginLeft: 6 }}>+{fmtEth(r.pending, 5)} drip</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPending > 0n && (
            <button className="dp-action" style={{ marginTop: 14 }} disabled={busy} onClick={claimAll}>
              {busy ? "Confirm in wallet…" : `Claim payouts (${fmtEth(totalPending, 6)} ETH)`}
            </button>
          )}
        </div>

        <div>
          <div className="dp-form-sheet">
            <p className="dp-sec">Your referral link</p>
            <p className="dp-agate" style={{ marginBottom: 8 }}>
              People who link up through this link pay 10% less in fees. You get {VENTURE.refShareBps / 100}% of the
              platform fee on their trades, paid in the same transaction.
            </p>
            <div className="dp-chit">
              <button className="dp-mono" style={{ background: "none", border: "none", padding: 0, color: "var(--up)", fontSize: 11, textAlign: "left", wordBreak: "break-all" }}
                onClick={() => navigator.clipboard?.writeText(refLink(me!)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                {copied ? "Copied" : refLink(me!)}
              </button>
            </div>
            {otherEarned.length > 0 && (
              <table className="dp-docket" style={{ marginTop: 12 }}>
                <thead><tr><th>Pair currency</th><th className="dp-num">Earned</th></tr></thead>
                <tbody>{otherEarned.map(([c, amt]) => (
                  <tr key={c}><td className="dp-mono">{short(c)}</td><td className="dp-num">{fmtEth(amt, 6)}</td></tr>
                ))}</tbody>
              </table>
            )}
          </div>

          {founderRows.length > 0 && (
            <div className="dp-form-sheet" style={{ marginTop: 14 }}>
              <p className="dp-sec">Coins you launched</p>
              {founderRows.map((r) => (
                <div key={r.v.address} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <Link className="dp-row-link" to={`/venture/${r.v.address}`} viewTransition style={{ display: "inline" }}>
                      <b>{r.v.name}</b> <span className="dp-mono" style={{ fontSize: 10.5 }}>${r.v.symbol}</span>
                    </Link>
                    <span className="dp-mono" style={{ fontSize: 11, color: "var(--dim)" }}>
                      {r.v.phase === "graduated" ? "trading" : `${pct(r.v.raisedWei, r.v.targetRaiseWei).toFixed(0)}% filled`}
                    </span>
                  </div>
                  <div style={{ display: "flex", gap: 8, marginTop: 8, flexWrap: "wrap" }}>
                    <button className="dp-action dp-ghost" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy} onClick={() => postUpdate(r)}>
                      Post update
                    </button>
                    {r.vestingClaimable > 0n && (
                      <button className="dp-action" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy} onClick={() => claimVest(r)}>
                        Claim {fmtTok(r.vestingClaimable)} vested
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
