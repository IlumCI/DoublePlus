import { useEffect, useState } from "react";
import { useWalletClient } from "wagmi";

import { confirmTx, loadUpdates, VENTURE, venturePc, vestingAbi, type Fill, type Venture as VentureT } from "../client";
import { termSheetRows, type RaiseMode } from "../raiseMode";
import { feePct } from "../curve";
import { Donut, Legend, SplitBar, type Slice } from "../charts";
import { CopyButton, fmtEth, fmtTok, pct, short } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";
import { env } from "../../lib/env";


export function ProjectPane({ v }: { v: VentureT }) {
  return (
    <div className="dp-story">
      {v.meta.description || v.meta.pitch
        ? <p>{v.meta.description || v.meta.pitch}</p>
        : <p className="dp-agate">No description.</p>}
    </div>
  );
}

export function UpdatesPane({ v }: { v: VentureT }) {
  const [updates, setUpdates] = useState<{ author: string; text: string; txHash: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    loadUpdates(v.address).then((u) => live && setUpdates(u)).catch(() => live && setUpdates([]));
    return () => { live = false; };
  }, [v.address]);

  if (updates === null) return <p className="dp-agate">Reading the update log…</p>;
  if (updates.length === 0) {
    return <p className="dp-agate">No updates yet. The creator posts them on-chain, where they can't be edited or deleted.</p>;
  }
  return (
    <div className="dp-typescript">
      {updates.slice().reverse().map((u) => (
        <div className="dp-entry" key={u.txHash}>
          <time>{short(u.author)}</time>
          <span style={{ whiteSpace: "pre-wrap" }}>{u.text}</span>
          {env.explorerUrl && <> <a className="dp-mono" style={{ fontSize: 10.5 }} href={`${env.explorerUrl}/tx/${u.txHash}`} target="_blank" rel="noreferrer">proof ↗</a></>}
        </div>
      ))}
    </div>
  );
}

export function BackersPane({ v, fills }: { v: VentureT; fills: Fill[] }) {
  if (fills.length === 0) return <p className="dp-agate">No buyers yet.</p>;
  const total = fills.reduce((s, f) => s + f.ethIn, 0n);
  return (
    <table className="dp-holders" style={{ width: "100%", borderCollapse: "collapse" }}>
      <tbody>
        {fills.slice().reverse().map((f) => {
          const share = total > 0n ? pct(f.ethIn, total) : 0;
          return (
            <tr key={f.txHash + f.buyer}>
              <td className="dp-mono">{short(f.buyer)}</td>
              <td style={{ width: "34%" }}><div className="dp-bar"><i style={{ ["--pct" as string]: `${share}%` }} /></div></td>
              <td className="dp-mono">{fmtTok(f.tokensOut)} ${v.symbol}</td>
              <td className="dp-mono" style={{ textAlign: "right", color: "var(--up)" }}>{fmtEth(f.ethIn, 4)} ETH</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function TermsPane({ v }: { v: VentureT }) {
  const days = Math.max(1, Math.round((v.deadline - v.createdAt) / 86_400));
  const founderSupply = v.vesting === "0x0000000000000000000000000000000000000000" ? 0 : 10;
  const supplySlices: Slice[] = [
    { label: "Sold on the curve", value: 60 },
    { label: "Pool liquidity", value: 40 - founderSupply },
    { label: "Founder, vesting", value: founderSupply },
  ];
  // Which rows a mode has is decided in raiseMode.ts and covered by its tests.
  // Progress belongs to the ring, and the vesting panel below states the
  // founder stake in full — both were being repeated here.
  const rows = termSheetRows(v.mode as RaiseMode, {
    targetEth: fmtEth(v.targetRaiseWei, 4),
    founderCutPct: (v.founderRaiseBps / 100).toFixed(1),
    days,
    antiSnipe: "15% for the first 5 s, 5% until 15 s; it goes to the buy wall",
  });
  return (
    <>
      <div className="dp-panel" style={{ marginBottom: 14 }}>
        <div className="dp-phead"><span>Where the supply sits</span></div>
        <div className="dp-pbody">
          <SplitBar slices={supplySlices} />
          <div style={{ marginTop: 12 }}><Legend slices={supplySlices} /></div>
        </div>
      </div>
      <div className="dp-sheet">
        <p className="dp-sec">Term sheet</p>
        <dl>{rows.map(([k, val]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{val}</dd></span>)}</dl>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <span className="dp-stamp">LOCKED</span>
        </div>
      </div>
    </>
  );
}

export function ContractCard({ v }: { v: VentureT }) {
  const vested = v.vesting !== "0x0000000000000000000000000000000000000000";
  const deployed = new Date(v.createdAt * 1000).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
  const rows: [string, React.ReactNode][] = [
    ["deployed", deployed],
    ["type", v.mode === 1 ? "open curve, no refunds" : "refunds if it misses its target"],
    ["fee policy", `${(v.policy.buyTaxBps / 100).toFixed(2)}% buy · ${(v.policy.sellTaxBps / 100).toFixed(2)}% sell`],
    ["fee split", `${v.policy.devBps / 100} / ${v.policy.dividendBps / 100} / ${v.policy.liquidityBps / 100} / ${v.policy.mmBps / 100}`],
    ["protocol fee", `${feePct(VENTURE.platformFeeBps)}%`],
    ...(v.mode === 1 ? [] : ([["per-wallet cap", `${fmtEth(v.maxBuyWei, 3)} ETH`]] as [string, React.ReactNode][])),
    ["founder stake", vested ? "vested from graduation" : "none"],
    ...(v.phase === "graduated"
      ? ([["liquidity", "locked in the V4 pool"]] as [string, React.ReactNode][])
      : []),
  ];
  return (
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>Contract</span>
        {env.explorerUrl && (
          <a href={`${env.explorerUrl}/address/${v.address}`} target="_blank" rel="noreferrer">source ↗</a>
        )}
      </div>
      <div className="dp-pbody">
        <div className="dp-spec">
          <div className="dp-spec-head">
            <CopyButton value={v.address} />
            <span>immutable</span>
          </div>
          {rows.map(([k, val]) => (
            <div className="dp-spec-row" key={k}><dt>{k}</dt><dd>{val}</dd></div>
          ))}
        </div>
        <p className="dp-spec-note">
          Fixed at launch. No one can change these numbers afterwards, including the creator
          and the platform: the contracts have no admin key and can't be upgraded.
        </p>
      </div>
    </div>
  );
}

export function WhoEarns({ v }: { v: VentureT }) {
  const avgTax = (v.policy.buyTaxBps + v.policy.sellTaxBps) / 2 / 100;
  const slices: Slice[] = [
    { label: "Creator", value: v.policy.devBps, note: "paid on every trade" },
    { label: "Holders", value: v.policy.dividendBps, note: "paid to you in ETH" },
    { label: "Liquidity", value: v.policy.liquidityBps, note: "locked into the pool" },
    { label: "Market-making", value: v.policy.mmBps, note: "keeps a bid under the price" },
  ];
  return (
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>Where each trade goes</span><span>{avgTax.toFixed(1)}% avg fee</span></div>
      <div className="dp-pbody dp-chartrow">
        <Donut slices={slices} size={116} thickness={18} center={`${avgTax.toFixed(1)}%`} sub="fee" />
        <div style={{ flex: 1, minWidth: 150 }}><Legend slices={slices} /></div>
      </div>
    </div>
  );
}

/** Founder vesting: visible to everyone, claimable by the founder. */
export function VestingCard({ v }: { v: VentureT }) {
  const { address: me } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [state, setState] = useState<{ start: number; duration: number; total: bigint; released: bigint; claimable: bigint } | null>(null);

  const none = v.vesting === "0x0000000000000000000000000000000000000000";
  useEffect(() => {
    if (none) return;
    let live = true;
    const refresh = () =>
      Promise.all([
        venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "startTime" }),
        venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "duration" }),
        venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "totalAllocation" }),
        venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "released" }),
        venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "claimable" }),
      ]).then(([s, d, t, r, c]) => live && setState({ start: Number(s), duration: Number(d), total: t as bigint, released: r as bigint, claimable: c as bigint }))
        .catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [v.vesting, none, busy]);

  if (none || !state) return null;
  const vestedPct = state.total > 0n ? pct(state.released + state.claimable, state.total) : 0;
  const isFounder = me && me.toLowerCase() === v.creator.toLowerCase();

  const claim = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: v.vesting, abi: vestingAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "Vested tokens claimed", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>Creator tokens, vesting</span><span>{vestedPct.toFixed(0)}% unlocked so far</span></div>
      <div className="dp-pbody">
        <div className="dp-meter" style={{ ["--pct" as string]: `${vestedPct}%` }}><i /></div>
        <div className="dp-tb-slip">
          <span>{fmtTok(state.released)} claimed</span>
          <span>{fmtTok(state.total)} total · {Math.round(state.duration / 86_400)}d linear</span>
        </div>
        {isFounder && state.claimable > 0n && (
          <button className="dp-action" style={{ width: "100%", marginTop: 10 }} disabled={busy} onClick={claim}>
            {busy ? "Confirm in wallet…" : `Claim ${fmtTok(state.claimable)} vested`}
          </button>
        )}
        <p className="dp-tb-note">Locked until graduation, then unlocks evenly over the vesting period.</p>
      </div>
    </div>
  );
}
