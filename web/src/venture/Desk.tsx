import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWalletClient } from "wagmi";

import {
  ercAbi, loadReferralEarnings, loadVentures, updatesAbi, VENTURE, venturePc, vestingAbi, type Venture,
} from "./client";
import { fmtEth, fmtTok, pct, short } from "./ui";
import { usePageMeta } from "./seo";
import { refLink } from "./referral";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

interface Holding {
  v: Venture;
  balance: bigint;
  pending: bigint;
  spent: bigint;
  vestingClaimable: bigint;
}

/** My desk: everything this wallet is owed across the launchpad — backed
 *  raises, holdings and dividends, referral earnings, founder tooling. */
export function Desk() {
  usePageMeta("Portfolio");
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [rows, setRows] = useState<Holding[] | null>(null);
  const [refEarned, setRefEarned] = useState<Map<string, bigint>>(new Map());
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = async () => {
      try {
        const ventures = await loadVentures();
        const out: Holding[] = [];
        for (const v of ventures) {
          const [balance, pending, spent] = await Promise.all([
            venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "balanceOf", args: [me] }) as Promise<bigint>,
            venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).catch(() => 0n) as Promise<bigint>,
            venturePc.readContract({ address: VENTURE.factory, abi: [{ type: "function", name: "spentWei", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }], outputs: [{ type: "uint256" }] }] as const, functionName: "spentWei", args: [v.address, me] }).catch(() => 0n) as Promise<bigint>,
          ]);
          let vestingClaimable = 0n;
          if (v.creator.toLowerCase() === me.toLowerCase() && v.vesting !== "0x0000000000000000000000000000000000000000") {
            vestingClaimable = (await venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "claimable" }).catch(() => 0n)) as bigint;
          }
          if (balance > 0n || pending > 0n || spent > 0n || vestingClaimable > 0n || v.creator.toLowerCase() === me.toLowerCase()) {
            out.push({ v, balance, pending, spent, vestingClaimable });
          }
        }
        if (live) setRows(out);
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
          <h1 className="dp-page-title">Your portfolio</h1>
          <p style={{ maxWidth: "56ch", color: "var(--dim)", fontSize: 13.5 }}>
            Connect to see your holdings, the ETH you have earned from every trade, your referral income and any
            vesting you can claim. Fee income lands automatically — this is where you watch it arrive.
          </p>
          <button className="dp-action" style={{ marginTop: 14 }} onClick={connectFirst}>Connect wallet</button>
        </div>
        <div className="dp-three-col" style={{ marginTop: 6 }}>
          <div className="dp-record"><span className="dp-k">Fee income</span><span className="dp-val">— <small style={{ fontSize: 13 }}>ETH</small></span><p className="dp-foot dp-agate">paid to holders every 15 minutes</p></div>
          <div className="dp-record"><span className="dp-k">Referral earnings</span><span className="dp-val">— <small style={{ fontSize: 13 }}>ETH</small></span><p className="dp-foot dp-agate">20% of the protocol fee on trades your link brings</p></div>
          <div className="dp-record"><span className="dp-k">Backed on curves</span><span className="dp-val">— <small style={{ fontSize: 13 }}>ETH</small></span><p className="dp-foot dp-agate">your curve spend comes back if a raise misses target</p></div>
        </div>
        <p className="dp-agate" style={{ marginTop: 14 }}>
          Nothing here is custodial: every figure is read from your wallet's position on-chain.
        </p>
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
      pushToast({ kind: "success", title: "All dividends claimed" });
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
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
  const totalBacked = (rows ?? []).reduce((a, r) => a + r.spent, 0n);
  const founderRows = (rows ?? []).filter((r) => r.v.creator.toLowerCase() === me!.toLowerCase());

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <p className="dp-form-no">CONNECTED: {short(me!)}</p>
        <h1 className="dp-page-title">Portfolio</h1>
        <p style={{ maxWidth: "58ch", color: "var(--dim)", fontSize: 13 }}>
          Everything this wallet is owed across the launchpad. Fee income is pushed to you automatically every 15 minutes —
          claiming by hand just gets it a few minutes sooner.
        </p>
      </div>

      <div className="dp-three-col">
        <div className="dp-record">
          <span className="dp-k">Fee income claimable</span>
          <span className="dp-val">{fmtEth(totalPending, 6)} <small style={{ fontSize: 13 }}>ETH</small></span>
          <p className="dp-foot dp-agate">across {(rows ?? []).filter((r) => r.pending > 0n).length} holdings</p>
        </div>
        <div className="dp-record">
          <span className="dp-k">Referral earnings</span>
          <span className="dp-val">{fmtEth(wethEarned, 6)} <small style={{ fontSize: 13 }}>ETH</small></span>
          <p className="dp-foot dp-agate">
            {otherEarned.length > 0 ? `plus ${otherEarned.length} other pair currenc${otherEarned.length === 1 ? "y" : "ies"}` : "paid inline on every referred trade"}
          </p>
        </div>
        <div className="dp-record">
          <span className="dp-k">Backed on curves</span>
          <span className="dp-val">{fmtEth(totalBacked, 4)} <small style={{ fontSize: 13 }}>ETH</small></span>
          <p className="dp-foot dp-agate">{(rows ?? []).filter((r) => r.spent > 0n).length} raises backed</p>
        </div>
      </div>

      <div className="dp-two-col" style={{ marginTop: 16, alignItems: "start" }}>
        <div className="dp-form-sheet">
          <p className="dp-sec">Holdings <span className="dp-agate">as the chain tells it</span></p>
          {rows === null ? (
            <p className="dp-agate">Reading your positions…</p>
          ) : rows.length === 0 ? (
            <p className="dp-agate">Nothing yet. Back a raise and it shows up here.</p>
          ) : (
            <table className="dp-docket">
              <thead><tr><th>Token</th><th className="dp-num">Balance</th><th className="dp-num">Backed</th><th className="dp-num">Fee income</th><th>Status</th></tr></thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.v.address}>
                    <td>
                      <Link className="dp-row-link" to={`/venture/${r.v.address}`} viewTransition>
                        <b>{r.v.name}</b> <span className="dp-mono" style={{ fontSize: 10.5 }}>${r.v.symbol}</span>
                      </Link>
                    </td>
                    <td className="dp-num">{r.balance > 0n ? fmtTok(r.balance) : "—"}</td>
                    <td className="dp-num">{r.spent > 0n ? `${fmtEth(r.spent, 4)} ETH` : "—"}</td>
                    <td className="dp-num" style={{ color: r.pending > 0n ? "var(--up)" : undefined }}>
                      {r.pending > 0n ? fmtEth(r.pending, 6) : "—"}
                    </td>
                    <td><span className={`dp-badge ${r.v.phase === "graduated" ? "dp-grad" : r.v.phase === "failed" ? "dp-dead" : "dp-live"}`}>
                      {r.v.phase === "graduated" ? "trading" : r.v.phase === "failed" ? "refund" : r.v.phase === "expired" ? "funded" : "live"}
                    </span></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {totalPending > 0n && (
            <button className="dp-action" style={{ marginTop: 14 }} disabled={busy} onClick={claimAll}>
              {busy ? "Confirm in wallet…" : `Claim all fee income (${fmtEth(totalPending, 6)} ETH)`}
            </button>
          )}
        </div>

        <div>
          <div className="dp-form-sheet">
            <p className="dp-sec">Your referral link <span className="dp-agate">{VENTURE.refShareBps / 100}% of the protocol fee</span></p>
            <p className="dp-agate" style={{ marginBottom: 8 }}>
              A wallet binds to your link on its first routed trade and stays bound. Your share settles in the
              same transaction as their trade — nothing to claim.
            </p>
            <div className="dp-chit">
              <button className="dp-mono" style={{ background: "none", border: "none", padding: 0, color: "var(--up)", fontSize: 11, textAlign: "left", wordBreak: "break-all" }}
                onClick={() => navigator.clipboard?.writeText(refLink(me!)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
                {copied ? "copied ✓" : refLink(me!)}
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
              <p className="dp-sec">Founder tools <span className="dp-agate">raises you opened</span></p>
              {founderRows.map((r) => (
                <div key={r.v.address} style={{ borderTop: "1px solid var(--line)", padding: "10px 0" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 10 }}>
                    <Link className="dp-row-link" to={`/venture/${r.v.address}`} viewTransition style={{ display: "inline" }}>
                      <b>{r.v.name}</b> <span className="dp-mono" style={{ fontSize: 10.5 }}>${r.v.symbol}</span>
                    </Link>
                    <span className="dp-mono" style={{ fontSize: 11, color: "var(--dim)" }}>
                      {pct(r.v.raisedWei, r.v.targetRaiseWei).toFixed(0)}% funded
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
