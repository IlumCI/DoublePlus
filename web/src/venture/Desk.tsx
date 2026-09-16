import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { formatEther, type Address } from "viem";

import {
  ercAbi, loadReferralEarnings, loadVentures, updatesAbi, VENTURE, venturePc, vestingAbi, type Venture,
} from "./client";
import { Flag, fmtEth, fmtTok, pct, short } from "./ui";
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
      <div className="vn-shell vn-rise grid h-72 place-items-center text-center">
        <div>
          <p className="vn-title" style={{ fontSize: 22 }}>Your desk is waiting.</p>
          <button className="vn-cta mt-4" style={{ width: "auto", padding: "11px 22px" }} onClick={connectFirst}>Connect wallet</button>
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

  return (
    <div className="vn-shell vn-rise" style={{ paddingBottom: 90 }}>
      <p className="vn-eyebrow mt-10">my desk</p>
      <h1 className="vn-title mt-1">Everything you're owed, in one place.</h1>

      <div className="mt-6 grid gap-4 sm:grid-cols-3">
        <div className="vn-card p-5">
          <p className="vn-eyebrow">unclaimed dividends</p>
          <p className="vn-num vn-num-big mt-1">{fmtEth(totalPending, 6)} <span style={{ fontSize: "0.45em", color: "var(--v-ink-2)" }}>ETH*</span></p>
          <button className="vn-cta mt-3" disabled={busy || totalPending === 0n} onClick={claimAll}>
            {busy ? "Confirm in wallet…" : "Claim all"}
          </button>
          <p className="vn-hint mt-2">*stock-paired ventures pay in their stock; auto-delivery also pushes these every 15 min.</p>
        </div>
        <div className="vn-card p-5">
          <p className="vn-eyebrow">referral earnings · lifetime</p>
          <p className="vn-num vn-num-big mt-1">{fmtEth(wethEarned, 6)} <span style={{ fontSize: "0.45em", color: "var(--v-ink-2)" }}>WETH</span></p>
          {otherEarned.length > 0 && (
            <p className="vn-hint mt-1">+ {otherEarned.length} other token{otherEarned.length === 1 ? "" : "s"} (paid per trade)</p>
          )}
          <button className="vn-cta ghost mt-3" onClick={() => {
            navigator.clipboard?.writeText(refLink(me as Address)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); });
          }}>
            {copied ? "Copied ✓" : "Copy my refer & earn link"}
          </button>
          <p className="vn-hint mt-2">Anyone who binds your link pays you {VENTURE.refShareBps / 100}% of the protocol fee on every trade, forever.</p>
        </div>
        <div className="vn-card p-5">
          <p className="vn-eyebrow">this wallet</p>
          <p className="vn-num mt-1 text-[15px]">{short(me ?? "")}</p>
          <p className="vn-hint mt-2">{(rows ?? []).length} venture position{(rows ?? []).length === 1 ? "" : "s"} tracked from chain state — nothing here relies on a backend.</p>
        </div>
      </div>

      <p className="vn-eyebrow mt-8 mb-3">positions</p>
      {rows === null ? (
        <div className="grid h-40 place-items-center" style={{ color: "var(--v-ink-3)" }}>Reading your positions…</div>
      ) : rows.length === 0 ? (
        <div className="vn-card grid place-items-center p-10 text-center">
          <Flag size={30} />
          <p className="mt-2 text-[14px]" style={{ color: "var(--v-ink-2)" }}>Nothing yet. <Link to="/" style={{ color: "var(--v-green-2)" }}>Back a raise</Link> or <Link to="/launch" style={{ color: "var(--v-green-2)" }}>found your own</Link>.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {rows.map((r) => (
            <div key={r.v.address} className="vn-card flex flex-wrap items-center gap-4 p-4">
              <Link to={`/venture/${r.v.address}`} className="flex min-w-0 flex-1 items-center gap-3">
                <span className="grid h-10 w-10 shrink-0 place-items-center overflow-hidden rounded-lg border" style={{ borderColor: "var(--v-edge-2)", background: "var(--v-panel-2)" }}>
                  {r.v.meta.logo ? <img src={r.v.meta.logo} alt="" className="h-full w-full object-cover" /> : <Flag size={18} />}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-bold">{r.v.name} <span className="vn-num" style={{ color: "var(--v-ink-3)" }}>${r.v.symbol}</span></span>
                  <span className="vn-hint">
                    {r.v.phase === "raising" && <>raising · {pct(r.v.raisedWei, r.v.targetRaiseWei).toFixed(0)}% funded</>}
                    {r.v.phase === "expired" && <>funded · awaiting graduation</>}
                    {r.v.phase === "graduated" && <>trading</>}
                    {r.v.phase === "failed" && <span style={{ color: "var(--v-red)" }}>failed · {r.spent > 0n ? "refund available" : "closed"}</span>}
                  </span>
                </span>
              </Link>
              <span className="vn-num text-[13px]">{fmtTok(r.balance)} held</span>
              {r.pending > 0n && <span className="vn-num text-[13px]" style={{ color: "var(--v-green-2)" }}>{fmtEth(r.pending, 6)} pending</span>}
              {r.vestingClaimable > 0n && (
                <button className="vn-cta ghost" style={{ width: "auto", padding: "8px 14px", fontSize: 12.5 }} disabled={busy} onClick={() => claimVest(r)}>
                  Claim {fmtTok(r.vestingClaimable)} vested
                </button>
              )}
              {r.v.creator.toLowerCase() === (me ?? "").toLowerCase() && r.v.phase === "graduated" && VENTURE.updates !== "0x0000000000000000000000000000000000000000" && (
                <button className="vn-cta ghost" style={{ width: "auto", padding: "8px 14px", fontSize: 12.5 }} disabled={busy} onClick={() => postUpdate(r)}>
                  Post update
                </button>
              )}
              {r.v.phase === "failed" && r.spent > 0n && (
                <Link to={`/venture/${r.v.address}`} className="vn-cta danger" style={{ width: "auto", padding: "8px 14px", fontSize: 12.5 }}>
                  Reclaim {formatEther(r.spent).slice(0, 8)} ETH
                </Link>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
