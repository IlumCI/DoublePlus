import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { formatEther, parseEther, type Address } from "viem";

import {
  ercAbi, factoryAbi, loadFills, loadVenture, quoteTokens, routerAbi, VENTURE, venturePc, vestingAbi,
  type Fill, type Venture as VentureT,
} from "./client";
import { Countdown, Flag, fmtEth, fmtTok, pct, short, useTick } from "./ui";
import { useWallet, errorText } from "../lib/useWallet";
import { useUi } from "../store";
import { env } from "../lib/env";

export function VenturePage() {
  const { address } = useParams<{ address: string }>();
  const [v, setV] = useState<VentureT | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);

  useEffect(() => {
    if (!address) return;
    let live = true;
    const refresh = () => {
      loadVenture(address as Address).then((x) => live && setV(x)).catch(() => undefined);
      loadFills(address as Address).then((f) => live && setFills(f)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => { live = false; clearInterval(id); };
  }, [address]);

  if (!v) {
    return <div className="vn-shell grid h-72 place-items-center" style={{ color: "var(--v-ink-3)" }}>Pulling the term sheet…</div>;
  }

  return (
    <div className="vn-shell vn-rise" style={{ paddingBottom: 90 }}>
      <Link to="/" className="vn-eyebrow mt-6 inline-block" style={{ color: "var(--v-ink-3)" }}>← all raises</Link>

      <div className="mt-3 grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        {/* Left: identity + term sheet + fills */}
        <div>
          <div className="flex items-start gap-4">
            <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border" style={{ borderColor: "var(--v-edge-2)", background: "var(--v-panel)" }}>
              {v.meta.logo ? <img src={v.meta.logo} alt="" className="h-full w-full object-cover" /> : <Flag size={30} />}
            </span>
            <div className="min-w-0">
              {v.phase === "raising" && <span className="vn-badge raising"><i />Raising · <Countdown deadline={v.deadline} /></span>}
              {v.phase === "expired" && <span className="vn-badge funded">Fully funded · awaiting graduation</span>}
              {v.phase === "graduated" && <span className="vn-badge graduated">Graduated · trading live</span>}
              {v.phase === "failed" && <span className="vn-badge failed">Round failed · refunds open</span>}
              <h1 className="vn-title mt-1.5">{v.name} <span className="vn-num" style={{ fontSize: "0.55em", color: "var(--v-green-2)" }}>${v.symbol}</span></h1>
              <p className="mt-1 text-[12px]" style={{ color: "var(--v-ink-3)" }}>
                founded by {short(v.creator)}{v.meta.sector ? <> · {v.meta.sector}</> : null} · {(v.taxBps / 100).toFixed(1)}% trade fee, 80% paid to holders
              </p>
            </div>
          </div>

          {(v.meta.pitch || v.meta.description) && (
            <p className="mt-4 max-w-xl text-[14px] leading-relaxed" style={{ color: "var(--v-ink-2)" }}>
              {v.meta.pitch || v.meta.description}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {v.meta.website && <a className="vn-chip" href={v.meta.website} target="_blank" rel="noreferrer">website</a>}
            {v.meta.twitter && <a className="vn-chip" href={v.meta.twitter} target="_blank" rel="noreferrer">x / twitter</a>}
            {env.explorerUrl && <a className="vn-chip" href={`${env.explorerUrl}/token/${v.address}`} target="_blank" rel="noreferrer">contract ↗</a>}
          </div>

          <TermSheet v={v} />

          <p className="vn-eyebrow mt-8 mb-2">backers</p>
          <div className="vn-rows vn-card px-4 py-1">
            {fills.length === 0 ? (
              <p className="py-4 text-center text-[13px]" style={{ color: "var(--v-ink-3)" }}>No backers yet. The curve starts at its lowest price.</p>
            ) : fills.map((f) => (
              <div className="r" key={f.txHash + f.buyer}>
                <span style={{ color: "var(--v-ink-2)" }}>{short(f.buyer)}</span>
                <span className="vn-num">{fmtTok(f.tokensOut)} ${v.symbol}</span>
                <span className="vn-num" style={{ color: "var(--v-green-2)" }}>{fmtEth(f.ethIn)} ETH</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: the action panel for the current phase */}
        <div>
          {v.phase === "raising" && <RaisePanel v={v} />}
          {v.phase === "expired" && <GraduatePanel v={v} />}
          {v.phase === "failed" && <FailPanel v={v} />}
          {v.phase === "graduated" && (
            <>
              <TradePanel v={v} />
              <VestingCard v={v} />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function TermSheet({ v }: { v: VentureT }) {
  const days = Math.round((v.deadline - v.createdAt) / 86_400);
  return (
    <>
      <p className="vn-eyebrow mt-8 mb-2">term sheet · on-chain</p>
      <div className="vn-sheet">
        <div className="tr"><span>term</span><span>value</span></div>
        <div className="tr"><span>Funding target</span><span className="vn-num">{fmtEth(v.targetRaiseWei, 4)} ETH</span></div>
        <div className="tr"><span>Founder's cut of the raise</span><span>{(v.founderRaiseBps / 100).toFixed(1)}% at graduation</span></div>
        <div className="tr"><span>Rest of the raise</span><span>locked pool liquidity</span></div>
        <div className="tr"><span>Founder stake</span><span>{v.vesting === "0x0000000000000000000000000000000000000000" ? "none" : "vested linearly after graduation"}</span></div>
        <div className="tr"><span>Round deadline</span><span>{days} day{days === 1 ? "" : "s"} · all-or-nothing refunds</span></div>
        <div className="tr"><span>Per-wallet cap</span><span className="vn-num">{fmtEth(v.maxBuyWei, 4)} ETH</span></div>
        <div className="tr"><span>Trade fee after graduation</span><span>{(v.taxBps / 100).toFixed(1)}% · 80% holders / 20% founder</span></div>
      </div>
    </>
  );
}

function RaisePanel({ v }: { v: VentureT }) {
  useTick();
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0n);

  useEffect(() => {
    if (!me) return;
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "spentWei", args: [v.address, me] })
      .then((x) => setSpent(x as bigint)).catch(() => undefined);
  }, [me, v.address, busy]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);
  const tokensOut = quoteTokens(v, parsed);
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const capLeft = v.maxBuyWei > spent ? v.maxBuyWei - spent : 0n;

  const buy = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "buy", args: [v.address], value: parsed, chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Backing submitted", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "You're on the cap table", txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Backing failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="vn-card p-5">
      <div className="flex items-center justify-between">
        <p className="vn-eyebrow">funding progress</p>
        <span className="vn-num text-[12px]" style={{ color: "var(--v-ink-2)" }}>{funded.toFixed(1)}%</span>
      </div>
      <p className="vn-num vn-num-big mt-2">{fmtEth(v.raisedWei, 4)} <span style={{ fontSize: "0.45em", color: "var(--v-ink-2)" }}>/ {fmtEth(v.targetRaiseWei, 4)} ETH</span></p>
      <div className="vn-track mt-3" style={{ ["--pct" as string]: `${funded}%` }}><i /></div>
      <div className="mt-1.5 flex justify-between text-[11.5px]" style={{ color: "var(--v-ink-3)" }}>
        <span className="vn-num">{fmtTok(v.soldWhole, true)} sold</span>
        <span className="vn-num">price {fmtEth(v.priceWei, 9)} ETH</span>
      </div>

      <div className="vn-field mt-5">
        <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="vn-chip shrink-0">ETH</span>
      </div>
      <p className="vn-num mt-2 h-4 text-[12.5px]" style={{ color: "var(--v-ink-2)" }}>
        {tokensOut > 0n ? `≈ ${fmtTok(tokensOut, true)} $${v.symbol} along the curve` : ""}
      </p>
      {isConnected && (
        <p className="vn-hint mt-1">your cap: {fmtEth(capLeft, 4)} ETH remaining of {fmtEth(v.maxBuyWei, 4)}</p>
      )}
      <button className="vn-cta mt-3" disabled={busy || (isConnected && parsed === 0n)} onClick={buy}>
        {busy ? "Confirm in wallet…" : isConnected ? `Back ${v.name}` : "Connect wallet"}
      </button>
      <p className="mt-3 text-center text-[11.5px]" style={{ color: "var(--v-ink-3)" }}>
        Early backers pay less — the price rises along the curve as the round fills.
        Miss the target by the deadline and everyone is refunded in full.
      </p>
    </div>
  );
}

function GraduatePanel({ v }: { v: VentureT }) {
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const graduate = async () => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "finalize", args: [v.address], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Graduating…", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Graduated. Trading is open.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Graduation failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const founderCut = (v.raisedWei * BigInt(v.founderRaiseBps)) / 10_000n;
  return (
    <div className="vn-card p-6 text-center">
      <Flag size={36} />
      <p className="vn-title mt-3" style={{ fontSize: 22 }}>Round fully funded.</p>
      <p className="mx-auto mt-1 max-w-xs text-[13px]" style={{ color: "var(--v-ink-2)" }}>
        {fmtEth(v.raisedWei, 4)} ETH raised. Anyone can trigger graduation: the founder is paid their
        {" "}{(v.founderRaiseBps / 100).toFixed(1)}% cut ({fmtEth(founderCut, 4)} ETH), the rest becomes locked
        liquidity, and trading opens.
      </p>
      <button className="vn-cta mt-4" disabled={busy} onClick={graduate}>
        {busy ? "Graduating…" : "Trigger graduation"}
      </button>
    </div>
  );
}

function FailPanel({ v }: { v: VentureT }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0n);
  const [bought, setBought] = useState(0n);

  useEffect(() => {
    if (!me) return;
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "spentWei", args: [v.address, me] })
      .then((x) => setSpent(x as bigint)).catch(() => undefined);
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "boughtTokens", args: [v.address, me] })
      .then((x) => setBought(x as bigint)).catch(() => undefined);
  }, [me, v.address, busy]);

  const act = async (fn: "abort" | "refund") => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      if (fn === "refund") {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.factory] })) as bigint;
        if (allowance < bought) {
          const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.factory, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await venturePc.waitForTransactionReceipt({ hash: a });
        }
      }
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn, args: [v.address], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: fn === "abort" ? "Closing the round…" : "Refunding…", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: fn === "abort" ? "Round closed. Refunds are open." : "Refunded in full.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: `${fn === "abort" ? "Close" : "Refund"} failed`, body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="vn-card p-6 text-center">
      <p className="vn-title mt-1" style={{ fontSize: 22 }}>This round didn't make it.</p>
      <p className="mx-auto mt-1 max-w-xs text-[13px]" style={{ color: "var(--v-ink-2)" }}>
        The deadline passed below target. All-or-nothing means nobody is left holding the bag: return your
        ${v.symbol} and reclaim your full spend.
      </p>
      {!v.aborted ? (
        <button className="vn-cta ghost mt-4" disabled={busy} onClick={() => act("abort")}>
          {busy ? "Confirm in wallet…" : "Close the round (opens refunds)"}
        </button>
      ) : spent > 0n ? (
        <button className="vn-cta danger mt-4" disabled={busy} onClick={() => act("refund")}>
          {busy ? "Confirm in wallet…" : `Reclaim ${fmtEth(spent, 5)} ETH`}
        </button>
      ) : (
        <p className="vn-hint mt-4">Nothing to reclaim from this wallet.</p>
      )}
      {v.aborted && spent > 0n && (
        <p className="vn-hint mt-2">Requires returning your full {fmtTok(bought)} ${v.symbol}.</p>
      )}
    </div>
  );
}

/** Post-graduation: ETH buy/sell through the RhRouter + dividend claim. */
function TradePanel({ v }: { v: VentureT }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [bal, setBal] = useState(0n);
  const [pending, setPending] = useState(0n);

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = () => {
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "balanceOf", args: [me] }).then((x) => live && setBal(x as bigint)).catch(() => undefined);
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).then((x) => live && setPending(x as bigint)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me, v.address]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);

  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      let hash: `0x${string}`;
      if (side === "buy") {
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", 0n], value: parsed, chain: wc.chain, account: wc.account });
      } else {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.router] })) as bigint;
        if (allowance < parsed) {
          const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.router, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await venturePc.waitForTransactionReceipt({ hash: a });
        }
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", 0n], chain: wc.chain, account: wc.account });
      }
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${side === "buy" ? "Buy" : "Sell"} confirmed`, txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Trade failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const claim = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Dividends claimed", txHash: hash });
      setPending(0n);
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="vn-card p-5">
      <div className="vn-seg">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} className={side === s ? "on" : ""} onClick={() => { setSide(s); setAmt(""); }}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <div className="vn-field mt-4">
        <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="vn-chip shrink-0">{side === "buy" ? "ETH" : `$${v.symbol}`}</span>
      </div>
      {side === "sell" && bal > 0n && (
        <p className="vn-hint mt-1.5">
          balance {fmtTok(bal)} · <button style={{ color: "var(--v-green-2)" }} onClick={() => setAmt(formatEther(bal))}>max</button>
        </p>
      )}
      <button className="vn-cta mt-3" disabled={busy || (isConnected && parsed === 0n)} onClick={go}>
        {busy ? "Confirm in wallet…" : isConnected ? (side === "buy" ? `Buy $${v.symbol}` : `Sell $${v.symbol}`) : "Connect wallet"}
      </button>

      {isConnected && pending > 0n && (
        <div className="mt-4 flex items-center justify-between rounded-xl border px-4 py-3" style={{ borderColor: "#2fd57555", background: "#2fd5750d" }}>
          <div>
            <p className="vn-eyebrow" style={{ fontSize: 10.5 }}>your dividends</p>
            <p className="vn-num text-[15px]" style={{ color: "var(--v-green-2)" }}>{fmtEth(pending, 6)} ETH</p>
          </div>
          <button className="vn-cta" style={{ width: "auto", padding: "9px 18px", fontSize: 13 }} disabled={busy} onClick={claim}>Claim</button>
        </div>
      )}
      <p className="mt-3 text-center text-[11.5px]" style={{ color: "var(--v-ink-3)" }}>
        Every trade pays holders 80% of the {(v.taxBps / 100).toFixed(1)}% fee — a dividend for holding the stock.
      </p>
    </div>
  );
}

/** Founder vesting: visible to everyone, claimable by the founder. */
function VestingCard({ v }: { v: VentureT }) {
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
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Vested tokens claimed", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="vn-card mt-4 p-5">
      <p className="vn-eyebrow">founder stake · vesting</p>
      <div className="vn-track mt-3" style={{ ["--pct" as string]: `${vestedPct}%` }}><i /></div>
      <div className="mt-1.5 flex justify-between text-[11.5px]" style={{ color: "var(--v-ink-3)" }}>
        <span className="vn-num">{fmtTok(state.released)} claimed</span>
        <span className="vn-num">{fmtTok(state.total)} total · {Math.round(state.duration / 86_400)}d linear</span>
      </div>
      {isFounder && state.claimable > 0n && (
        <button className="vn-cta ghost mt-3" disabled={busy} onClick={claim}>
          {busy ? "Confirm in wallet…" : `Claim ${fmtTok(state.claimable)} vested $${v.symbol}`}
        </button>
      )}
      <p className="vn-hint mt-2">
        The founder's stake unlocked nothing until the raise succeeded, and unlocks linearly from graduation.
      </p>
    </div>
  );
}
