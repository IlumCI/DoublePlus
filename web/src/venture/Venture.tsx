import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { formatEther, parseEther, type Address } from "viem";

import {
  ercAbi, factoryAbi, hookAbi, loadFills, loadUpdates, loadVenture, quoteTokens, routerAbi, VENTURE, venturePc,
  vestingAbi, type Fill, type Venture as VentureT,
} from "./client";
import { PriceChart, TradeTape, usePoolTrades } from "./Chart";
import { refLink, storedRef } from "./referral";
import { ago, Countdown, CurveBar, fmtEth, fmtMcap, fmtTok, Monogram, pct, short, StatusBadge, useEthUsd, useTick } from "./ui";
import { useWallet, errorText } from "../lib/useWallet";
import { useUi } from "../store";
import { env } from "../lib/env";

type Tab = "project" | "updates" | "trades" | "backers" | "terms";

export function VenturePage() {
  const { address } = useParams<{ address: string }>();
  const [v, setV] = useState<VentureT | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const ethUsd = useEthUsd();

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
    return <div className="dp-shell" style={{ padding: "80px 18px", textAlign: "center", color: "var(--faint)" }}>Pulling the term sheet…</div>;
  }
  return <VentureBody v={v} fills={fills} ethUsd={ethUsd} />;
}

function VentureBody({ v, fills, ethUsd }: { v: VentureT; fills: Fill[]; ethUsd: number }) {
  const trades = usePoolTrades(v);
  const [tab, setTab] = useState<Tab>(v.phase === "graduated" ? "trades" : "project");

  const TABS: [Tab, string][] = [
    ["project", "The project"],
    ["updates", "Updates"],
    ...(v.phase === "graduated" ? ([["trades", "Trades"]] as [Tab, string][]) : []),
    ["backers", "Backers"],
    ["terms", "Terms"],
  ];

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <Link to="/" viewTransition className="dp-mono" style={{ display: "inline-block", marginTop: 14, fontSize: 11, color: "var(--faint)" }}>← all raises</Link>

      <div className="dp-coinhead">
        <Monogram v={v} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h1>{v.name} <span className="dp-mono" style={{ fontSize: 14, color: "var(--dim)" }}>${v.symbol}</span></h1>
          {(v.meta.pitch || v.meta.description) && <p className="dp-oneliner">{v.meta.pitch || v.meta.description}</p>}
          <p className="dp-prov" style={{ margin: "4px 0 0" }}>
            created by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago
            {v.meta.sector ? <> · {v.meta.sector}</> : null} · <StatusBadge v={v} />
          </p>
        </div>
        <div className="dp-mcbig">
          <span className="dp-k">market cap</span><br />
          <span className="dp-v">{fmtMcap(v, ethUsd)}</span><br />
          <span className="dp-mono" style={{ fontSize: 12, color: "var(--faint)" }}>{fmtEth(v.priceWei, 9)} ETH / token</span>
        </div>
      </div>

      <div className="dp-coingrid">
        {/* LEFT: the market, then everything that justifies it */}
        <div>
          {v.phase === "graduated" ? <PriceChart v={v} trades={trades} /> : <CurvePanel v={v} />}

          <div className="dp-tabbar">
            {TABS.map(([k, label]) => (
              <button key={k} className={tab === k ? "on" : ""} onClick={() => setTab(k)}>
                {label}
                {k === "backers" && fills.length > 0 && <span className="dp-cnt"> ({fills.length})</span>}
              </button>
            ))}
          </div>

          <div className="dp-tabpane" hidden={tab !== "project"}><ProjectPane v={v} /></div>
          <div className="dp-tabpane" hidden={tab !== "updates"}><UpdatesPane v={v} /></div>
          {v.phase === "graduated" && <div className="dp-tabpane" hidden={tab !== "trades"}><TradeTape v={v} trades={trades} /></div>}
          <div className="dp-tabpane" hidden={tab !== "backers"}><BackersPane v={v} fills={fills} /></div>
          <div className="dp-tabpane" hidden={tab !== "terms"}><TermsPane v={v} /></div>
        </div>

        {/* RIGHT: the money box, always above the fold */}
        <div>
          {v.phase === "raising" && <RaisePanel v={v} />}
          {v.phase === "expired" && <GraduatePanel v={v} />}
          {v.phase === "failed" && <FailPanel v={v} />}
          {v.phase === "graduated" && <TradePanel v={v} />}

          {v.phase === "graduated" && <VestingCard v={v} />}
          <WhoEarns v={v} />
          <ReferralChit />
        </div>
      </div>
    </div>
  );
}

/** Pre-graduation: the curve itself is the chart. */
function CurvePanel({ v }: { v: VentureT }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const bars = 36;
  return (
    <div className="dp-panel dp-chartpanel">
      <div className="dp-phead"><span>${v.symbol} bonding curve</span><span>{funded.toFixed(1)}% funded</span></div>
      <div className="dp-pbody">
        <svg className="dp-px" width="100%" viewBox="0 0 560 240" preserveAspectRatio="none" style={{ height: 240 }} aria-hidden>
          {Array.from({ length: bars }, (_, i) => {
            const h = 30 + (i / (bars - 1)) * 190;
            const filled = (i / bars) * 100 <= funded;
            return <rect key={i} x={i * 15.5 + 2} y={232 - h} width={11} height={h}
              fill="var(--up)" opacity={filled ? 0.35 + (i / bars) * 0.65 : 0.1} />;
          })}
        </svg>
        <p className="dp-agate" style={{ padding: "4px 6px 2px" }}>
          Price rises with every buy — early backers pay less. Pricing is the exact integral of the curve, so
          splitting an order into many small ones costs exactly the same.
        </p>
      </div>
    </div>
  );
}

function ProjectPane({ v }: { v: VentureT }) {
  const days = Math.max(1, Math.round((v.deadline - v.createdAt) / 86_400));
  return (
    <div className="dp-story">
      {v.meta.description || v.meta.pitch
        ? <p>{v.meta.description || v.meta.pitch}</p>
        : <p className="dp-agate">This raise filed no description on-chain.</p>}

      <h2>What the money does</h2>
      <p>
        The founder takes <b>{(v.founderRaiseBps / 100).toFixed(1)}%</b> of the raise as funding, released only if
        the round succeeds. Everything else — the rest of the raise and the remaining supply — becomes locked
        pool liquidity at graduation.
      </p>

      <h2>The shape of the raise</h2>
      <ul className="dp-milestones">
        <li className={v.raisedWei > 0n ? "dp-done" : ""}>Raise opened on a rising price curve</li>
        <li className={pct(v.raisedWei, v.targetRaiseWei) >= 50 ? "dp-done" : ""}>Half the target committed</li>
        <li className={v.phase === "expired" || v.phase === "graduated" ? "dp-done" : ""}>Target reached — {fmtEth(v.targetRaiseWei, 3)} ETH in {days} days</li>
        <li className={v.phase === "graduated" ? "dp-done" : ""}>Graduated into a locked Uniswap V4 pool</li>
      </ul>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
        {v.meta.website && <a className="dp-chit" href={v.meta.website} target="_blank" rel="noreferrer">website ↗</a>}
        {v.meta.twitter && <a className="dp-chit" href={v.meta.twitter} target="_blank" rel="noreferrer">x / twitter ↗</a>}
        {env.explorerUrl && <a className="dp-chit" href={`${env.explorerUrl}/token/${v.address}`} target="_blank" rel="noreferrer">contract ↗</a>}
      </div>
    </div>
  );
}

function UpdatesPane({ v }: { v: VentureT }) {
  const [updates, setUpdates] = useState<{ author: string; text: string; txHash: string }[] | null>(null);
  useEffect(() => {
    let live = true;
    loadUpdates(v.address).then((u) => live && setUpdates(u)).catch(() => live && setUpdates([]));
    return () => { live = false; };
  }, [v.address]);

  if (updates === null) return <p className="dp-agate">Reading the update log…</p>;
  if (updates.length === 0) {
    return <p className="dp-agate">No founder updates posted yet. Updates are written on-chain and cannot be edited or deleted afterwards.</p>;
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

function BackersPane({ v, fills }: { v: VentureT; fills: Fill[] }) {
  if (fills.length === 0) return <p className="dp-agate">No backers yet — the curve starts at its lowest price.</p>;
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

function TermsPane({ v }: { v: VentureT }) {
  const days = Math.max(1, Math.round((v.deadline - v.createdAt) / 86_400));
  const rows: [string, string][] = [
    ["Funding target", `${fmtEth(v.targetRaiseWei, 4)} ETH`],
    ["Raised", `${fmtEth(v.raisedWei, 4)} ETH (${pct(v.raisedWei, v.targetRaiseWei).toFixed(1)}%)`],
    ["Founder cut of raise", `${(v.founderRaiseBps / 100).toFixed(1)}% — at graduation only`],
    ["Founder stake", v.vesting === "0x0000000000000000000000000000000000000000" ? "none" : "vested linearly from graduation"],
    ["Round deadline", `${days} day${days === 1 ? "" : "s"} · all-or-nothing refunds`],
    ["Per-wallet cap", `${fmtEth(v.maxBuyWei, 4)} ETH`],
    ["Buy / sell tax", `${(v.policy.buyTaxBps / 100).toFixed(2)}% / ${(v.policy.sellTaxBps / 100).toFixed(2)}%`],
    ["Tax split", `dev ${v.policy.devBps / 100} · dividends ${v.policy.dividendBps / 100} · liquidity ${v.policy.liquidityBps / 100} · MM ${v.policy.mmBps / 100}`],
    ["Protocol fee", `${(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade, ${VENTURE.refShareBps / 100}% of it to referrers`],
    ["Anti-snipe", "15% premium for 5s, 5% to 15s → into the quote walls"],
    ["Token", v.address],
  ];
  return (
    <>
      <div className="dp-sheet">
        <p className="dp-sec">Term sheet <span className="dp-agate">sworn at launch · immutable after</span></p>
        <dl>{rows.map(([k, val]) => <span key={k} style={{ display: "contents" }}><dt>{k}</dt><dd>{val}</dd></span>)}</dl>
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 14 }}>
          <span className="dp-stamp">LOCKED</span>
        </div>
      </div>
      <p className="dp-agate" style={{ marginTop: 10 }}>
        Every number above was written into the factory at launch. Nobody — the founder, the protocol, this
        website — can change them afterwards.
      </p>
    </>
  );
}

function WhoEarns({ v }: { v: VentureT }) {
  const avgTax = (v.policy.buyTaxBps + v.policy.sellTaxBps) / 2 / 100;
  return (
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>Who earns here</span></div>
      <div className="dp-pbody" style={{ fontFamily: "var(--mono)", fontSize: 11.5, color: "var(--dim)", display: "grid", gap: 5 }}>
        <span>founder: <b style={{ color: "var(--up)" }}>{(avgTax * v.policy.devBps / 10_000).toFixed(2)}%</b> of every trade, forever</span>
        <span>holders: <b style={{ color: "var(--up)" }}>{(avgTax * v.policy.dividendBps / 10_000).toFixed(2)}%</b> back as ETH dividends</span>
        <span>the pool: <b style={{ color: "var(--up)" }}>{(avgTax * (v.policy.liquidityBps + v.policy.mmBps) / 10_000).toFixed(2)}%</b> into liquidity + quote walls</span>
        <span>you, as referrer: {VENTURE.refShareBps / 100}% of the protocol fee</span>
      </div>
    </div>
  );
}

function ReferralChit() {
  const { address: me } = useWallet();
  const [copied, setCopied] = useState(false);
  if (!me) return null;
  return (
    <div className="dp-chit" style={{ marginTop: 12 }}>
      <b>REFERRAL LINK</b> — earns {VENTURE.refShareBps / 100}% of the protocol fee on every trade your link
      brings, paid in the same transaction:<br />
      <button className="dp-mono" style={{ fontSize: 10.5, background: "none", border: "none", padding: 0, color: "var(--up)", textAlign: "left", wordBreak: "break-all" }}
        onClick={() => navigator.clipboard?.writeText(refLink(me)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })}>
        {copied ? "copied ✓" : refLink(me)}
      </button>
    </div>
  );
}

/** One-tap referral binding: shown when a ?ref= link was followed and the
 *  connected wallet has not bound a referrer yet. */
function ReferralBanner() {
  const { address: me, isConnected } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [bound, setBound] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const ref = storedRef();

  useEffect(() => {
    if (!me) return;
    venturePc.readContract({ address: VENTURE.hook, abi: hookAbi, functionName: "referrerOf", args: [me] })
      .then((r) => setBound(String(r))).catch(() => undefined);
  }, [me, busy]);

  if (!isConnected || !ref || !me || ref.toLowerCase() === me.toLowerCase()) return null;
  if (!bound || bound !== "0x0000000000000000000000000000000000000000") return null;

  const activate = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: VENTURE.hook, abi: hookAbi, functionName: "setReferrer", args: [ref], chain: wc.chain, account: wc.account });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Referral activated", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Activation failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="dp-chit" style={{ margin: "0 14px 12px", borderColor: "var(--up-dim)" }}>
      You arrived through {short(ref)}'s link. Activating costs one tiny transaction and changes none of your fees.{" "}
      <button className="dp-mono" style={{ background: "none", border: "none", color: "var(--up)", padding: 0 }} disabled={busy} onClick={activate}>
        {busy ? "confirm…" : "activate →"}
      </button>
    </div>
  );
}

/** The raise box: back this project on the curve. */
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
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs"><button className="dp-buy on" style={{ gridColumn: "1 / -1" }}>Back this raise</button></div>
      <div className="dp-tb-body">
        <ReferralBanner />
        <div className="dp-tb-amt">
          <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span>ETH</span>
        </div>
        <div className="dp-quicks">
          {["0.05", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)}
        </div>
        <p className="dp-tb-est">
          {tokensOut > 0n ? <>you receive ≈ <b>{fmtTok(tokensOut, true)} ${v.symbol}</b></> : <>price rises with every buy — early backers pay less</>}
        </p>
        <button className="dp-tb-go dp-buy" disabled={busy || (isConnected && parsed === 0n)} onClick={buy}>
          {busy ? "Confirm in wallet…" : isConnected ? `Back ${v.name}` : "Connect wallet"}
        </button>
        <div className="dp-tb-slip">
          <span>{isConnected ? `cap left ${fmtEth(capLeft, 3)} ETH` : `cap ${fmtEth(v.maxBuyWei, 3)} ETH / wallet`}</span>
          <span><Countdown deadline={v.deadline} /> left</span>
        </div>
        <p className="dp-tb-note">All-or-nothing: if the raise misses its target by the deadline, you reclaim every wei.</p>
      </div>
      <div className="dp-gradblock">
        <div className="dp-lbl"><span>bonding curve progress</span><b>{funded.toFixed(1)}%</b></div>
        <CurveBar v={v} />
        <p>At 100% the raise graduates: the founder cut pays out, the rest locks as pool liquidity, and trading opens. Automatic and irreversible.</p>
      </div>
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
    <div className="dp-panel dp-tradebox">
      <div className="dp-phead"><span>Fully funded</span><span className="dp-badge dp-soon">target reached</span></div>
      <div className="dp-pbody">
        <p style={{ fontSize: 13, color: "var(--dim)", margin: "0 0 12px" }}>
          {fmtEth(v.raisedWei, 4)} ETH raised. Anyone can trigger graduation: the founder is paid their{" "}
          {(v.founderRaiseBps / 100).toFixed(1)}% cut ({fmtEth(founderCut, 4)} ETH), the rest becomes locked
          liquidity, and trading opens.
        </p>
        <button className="dp-tb-go dp-buy" disabled={busy} onClick={graduate}>
          {busy ? "Graduating…" : "Trigger graduation"}
        </button>
      </div>
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
    <div className="dp-panel dp-tradebox">
      <div className="dp-phead"><span>Refund</span><span className="dp-badge dp-dead">raise failed</span></div>
      <div className="dp-pbody">
        <p style={{ fontSize: 13, color: "var(--dim)", margin: "0 0 12px" }}>
          The deadline passed below target. All-or-nothing means nobody is left holding the bag: return your
          ${v.symbol} and reclaim your full spend. The founder allocation is burned.
        </p>
        {!v.aborted ? (
          <button className="dp-tb-go dp-buy" style={{ background: "var(--up-dim)" }} disabled={busy} onClick={() => act("abort")}>
            {busy ? "Confirm in wallet…" : "Close the round (opens refunds)"}
          </button>
        ) : spent > 0n ? (
          <button className="dp-tb-go dp-buy" disabled={busy} onClick={() => act("refund")}>
            {busy ? "Confirm in wallet…" : `Reclaim ${fmtEth(spent, 5)} ETH`}
          </button>
        ) : (
          <p className="dp-agate">Nothing to reclaim from this wallet.</p>
        )}
        {v.aborted && spent > 0n && <p className="dp-tb-note">Requires returning your full {fmtTok(bought)} ${v.symbol}.</p>}
      </div>
    </div>
  );
}

/** Post-graduation: ETH buy/sell through the router + dividend claim. */
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

  const tax = side === "buy" ? v.policy.buyTaxBps : v.policy.sellTaxBps;
  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmt(""); }}>Buy</button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmt(""); }}>Sell</button>
      </div>
      <div className="dp-tb-body">
        <ReferralBanner />
        <div className="dp-tb-amt">
          <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span>{side === "buy" ? "ETH" : `$${v.symbol}`}</span>
        </div>
        <div className="dp-quicks">
          {side === "buy"
            ? ["0.05", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)
            : ["25%", "50%", "75%", "max"].map((q, i) => (
              <button key={q} onClick={() => setAmt(formatEther(bal * BigInt([25, 50, 75, 100][i]) / 100n))}>{q}</button>
            ))}
        </div>
        {side === "sell" && bal > 0n && <p className="dp-tb-est">balance <b>{fmtTok(bal)} ${v.symbol}</b></p>}
        <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`} disabled={busy || (isConnected && parsed === 0n)} onClick={go}>
          {busy ? "Confirm in wallet…" : isConnected ? `${side === "buy" ? "Buy" : "Sell"} $${v.symbol}` : "Connect wallet"}
        </button>
        <div className="dp-tb-slip">
          <span>slippage 1%</span>
          <span>fees: {(tax / 100).toFixed(1)}% + {(VENTURE.platformFeeBps / 100).toFixed(1)}% protocol</span>
        </div>

        {isConnected && pending > 0n && (
          <div className="dp-chit" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span>your dividends<br /><b style={{ color: "var(--up)", fontFamily: "var(--mono)" }}>{fmtEth(pending, 6)} ETH</b></span>
            <button className="dp-action" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy} onClick={claim}>Claim</button>
          </div>
        )}
      </div>
      <div className="dp-gradblock">
        <div className="dp-lbl"><span>bonding curve progress</span><b>100%</b></div>
        <CurveBar v={v} />
        <p>Graduated. Liquidity is locked in the Uniswap V4 pool and the curve is closed forever.</p>
      </div>
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
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>Founder stake · vesting</span><span>{vestedPct.toFixed(0)}%</span></div>
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
        <p className="dp-tb-note">Unlocked nothing until the raise succeeded; unlocks linearly from graduation.</p>
      </div>
    </div>
  );
}
