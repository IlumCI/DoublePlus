import { useEffect, useMemo, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { useBalance, useWalletClient } from "wagmi";
import { formatEther, parseEther, type Address } from "viem";

import {
  ercAbi, factoryAbi, hookAbi, loadFills, loadUpdates, loadVenture, quoteSellWei, quoteTokens,
  routerAbi, SOCIAL_FIELDS, toCandles, VENTURE, venturePc, vestingAbi,
  type Fill, type PoolTrade, type Venture as VentureT,
} from "./client";
import { marketStats } from "./stats";
import { profileLinks, useDexProfile, type DexProfile } from "../lib/dexscreener";
import { PriceChart, TradeTape, usePoolTrades } from "./Chart";
import { refLink, storedRef } from "./referral";
import { Donut, Legend, Ring, SplitBar, type Slice } from "./charts";
import { usePageMeta } from "./seo";
import { ago, BuySellStrength, Change, changePct, CopyButton, Countdown, CurveBar, Delta, DexBadge, fmtEth, fmtMcap,
  fmtTok, fmtUsdV, Monogram, pct, short, StatCell, StatusBadge, useEthUsd, useTick } from "./ui";
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

  usePageMeta(v ? `${v.name} ($${v.symbol})` : null, v?.meta.pitch);

  if (!v) {
    return <div className="dp-shell" style={{ padding: "80px 18px", textAlign: "center", color: "var(--faint)" }}>Pulling the term sheet…</div>;
  }
  return <VentureBody v={v} fills={fills} ethUsd={ethUsd} />;
}

function VentureBody({ v, fills, ethUsd }: { v: VentureT; fills: Fill[]; ethUsd: number }) {
  const trades = usePoolTrades(v);
  const dex = useDexProfile(v.address);
  const [params, setParams] = useSearchParams();
  const fallbackTab: Tab = v.phase === "graduated" ? "trades" : "project";
  const tab = (params.get("tab") as Tab) || fallbackTab;
  const setTab = (next: Tab) => {
    const p = new URLSearchParams(params);
    if (next === fallbackTab) p.delete("tab"); else p.set("tab", next);
    setParams(p, { replace: true });
  };
  const candles = useMemo(() => toCandles(trades, 3600), [trades]);
  const change24 = useMemo(() => changePct(candles.slice(-24)), [candles]);

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

      {v.meta.banner && (
        <div className="dp-banner"><img src={v.meta.banner} alt="" loading="lazy" /></div>
      )}

      <div className="dp-coinhead">
        <Monogram v={v} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h1>{v.name} <span className="dp-mono" style={{ fontSize: 14, color: "var(--dim)" }}>${v.symbol}</span></h1>
          {(v.meta.pitch || v.meta.description) && <p className="dp-oneliner">{v.meta.pitch || v.meta.description}</p>}
          <p className="dp-prov" style={{ margin: "4px 0 0" }}>
            created by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago
            {v.meta.sector ? <> · {v.meta.sector}</> : null} · <StatusBadge v={v} /> <DexBadge profile={dex} />
          </p>
          <Socials meta={v.meta} dex={dex} />
        </div>
        <div className="dp-mcbig">
          <span className="dp-k">market cap</span><br />
          <span className="dp-v">{fmtMcap(v, ethUsd)}</span><br />
          {v.phase === "graduated"
            ? <span className="dp-mono" style={{ fontSize: 12 }}><Change pct={change24} /> <span style={{ color: "var(--faint)" }}>24h</span></span>
            : null}
        </div>
      </div>

      {v.phase === "graduated" && <StatBar v={v} trades={trades} ethUsd={ethUsd} />}

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
          <div className="dp-tabpane" hidden={tab !== "terms"}><TermsPane v={v} /><VestingCard v={v} /></div>
        </div>

        {/* RIGHT: the money box, always above the fold */}
        <div>
          {v.phase === "raising" && <RaisePanel v={v} />}
          {v.phase === "expired" && <GraduatePanel v={v} />}
          {v.phase === "failed" && <FailPanel v={v} />}
          {v.phase === "graduated" && <TradePanel v={v} />}

          <DexPanel v={v} dex={dex} />
          <ContractCard v={v} />
          <WhoEarns v={v} />
          <ReferralChit />
        </div>
      </div>
    </div>
  );
}

/** Pre-graduation: the curve itself is the chart. */
/** The project's own channels. A trader checks these before anything else,
 *  so they sit with the name rather than buried in a tab. */
function Socials({ meta, dex }: { meta: VentureT["meta"]; dex?: DexProfile }) {
  const onChain: { label: string; url: string }[] = SOCIAL_FIELDS
    .map(([key, label]) => ({ label: label as string, url: meta[key] ?? "" }))
    .filter((l) => /^https?:\/\//i.test(l.url));
  // A paid DEX Screener profile often carries a channel the founder never put
  // in the on-chain metadata. Show it, but never shadow the on-chain value:
  // that one the contract vouches for, this one a third party holds.
  const have = new Set(onChain.map((l) => l.url.toLowerCase().replace(/\/+$/, "")));
  const extra = profileLinks(dex?.info ?? null).filter((l) => !have.has(l.url.toLowerCase().replace(/\/+$/, "")));
  const links = [...onChain, ...extra];
  if (links.length === 0) return null;
  return (
    <div className="dp-socials">
      {links.map(({ label, url }, i) => (
        <a key={`${label}-${i}`} href={url} target="_blank" rel="noreferrer noopener">{label} ↗</a>
      ))}
    </div>
  );
}

/** Price, size and momentum, read straight off the swap log. */
function StatBar({ v, trades, ethUsd }: { v: VentureT; trades: PoolTrade[]; ethUsd: number }) {
  const st = useMemo(() => marketStats(trades), [trades]);
  const priceEth = Number(st.priceWei) / 1e18;
  return (
    <>
      <div className="dp-statbar">
        <StatCell k="price">{ethUsd > 0 && priceEth > 0 ? fmtUsdV(priceEth * ethUsd) : `${fmtEth(st.priceWei, 8)}`}</StatCell>
        <StatCell k="market cap">{fmtMcap(v, ethUsd)}</StatCell>
        <StatCell k="24h vol">{ethUsd > 0 ? fmtUsdV((Number(st.vol24Wei) / 1e18) * ethUsd) : `${fmtEth(st.vol24Wei, 3)} ETH`}</StatCell>
        <StatCell k="24h txns">{st.buys24 + st.sells24}</StatCell>
        <StatCell k="5m"><Delta pct={st.change.m5} /></StatCell>
        <StatCell k="1h"><Delta pct={st.change.h1} /></StatCell>
        <StatCell k="4h"><Delta pct={st.change.h4} /></StatCell>
        <StatCell k="24h"><Delta pct={st.change.h24} /></StatCell>
      </div>
      <div className="dp-panel" style={{ marginBottom: 14 }}>
        <div className="dp-pbody">
          <BuySellStrength buyWei={st.buyVol24Wei} sellWei={st.sellVol24Wei} buys={st.buys24} sells={st.sells24} />
        </div>
      </div>
    </>
  );
}

function CurvePanel({ v }: { v: VentureT }) {
  const bars = 36;
  // Purely the shape of the pricing, not the progress: the ring in the trade
  // box is the one place that reads how far along the raise is. Encoding it
  // here too gave the same number two visualisations on one screen.
  return (
    <div className="dp-panel dp-chartpanel">
      <div className="dp-phead"><span>${v.symbol} bonding curve</span></div>
      <div className="dp-pbody">
        <svg className="dp-px" width="100%" viewBox="0 0 560 150" preserveAspectRatio="none" style={{ height: 150 }} aria-hidden>
          {Array.from({ length: bars }, (_, i) => {
            const h = 18 + (i / (bars - 1)) * 120;
            return <rect key={i} x={i * 15.5 + 2} y={142 - h} width={11} height={h}
              fill="var(--up)" opacity={0.16 + (i / bars) * 0.34} />;
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
  return (
    <div className="dp-story">
      {v.meta.description || v.meta.pitch
        ? <p>{v.meta.description || v.meta.pitch}</p>
        : <p className="dp-agate">This raise filed no description on-chain.</p>}

      {(v.meta.website || v.meta.twitter) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: 16 }}>
          {v.meta.website && <a className="dp-chit" href={v.meta.website} target="_blank" rel="noreferrer">website ↗</a>}
          {v.meta.twitter && <a className="dp-chit" href={v.meta.twitter} target="_blank" rel="noreferrer">x / twitter ↗</a>}
        </div>
      )}
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
  const founderSupply = v.vesting === "0x0000000000000000000000000000000000000000" ? 0 : 10;
  const supplySlices: Slice[] = [
    { label: "Sold on the curve", value: 60 },
    { label: "Pool liquidity", value: 40 - founderSupply },
    { label: "Founder, vesting", value: founderSupply },
  ];
  const rows: [string, string][] = [
    ["Funding target", `${fmtEth(v.targetRaiseWei, 4)} ETH`],
    // Progress belongs to the ring, and the vesting panel below states the
    // founder stake in full — both were being repeated here.
    ["Founder cut of raise", `${(v.founderRaiseBps / 100).toFixed(1)}% — at graduation only`],
    ["Round deadline", `${days} day${days === 1 ? "" : "s"}`],
    ["Anti-snipe", "15% premium for 5s, 5% to 15s → into the quote walls"],
  ];
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

/** The contract itself, as a spec sheet. Immutability is the headline: these
 *  numbers were fixed at deployment and there is no key that edits them. */
/** DEX Screener presence. Whether a token's info there is paid for is one of
 *  the first things a trader checks, because an unpaid listing on the venue
 *  everyone browses shows up as a nameless grey row. This states the status,
 *  names the evidence behind it, and refuses to dress it up as a safety
 *  rating — paid info proves spend, nothing more. */
function DexPanel({ v, dex }: { v: VentureT; dex: DexProfile }) {
  // Pre-graduation there is no pair to index, so there is nothing to report.
  if (v.phase !== "graduated" && dex.state === "unlisted") return null;
  if (dex.state === "unknown") return null;

  // The badge already says "dex paid", so the note carries what it cannot:
  // when, and on what evidence. Repeating the word would be the same fact
  // twice, six pixels apart.
  const note = dex.state === "paid"
    ? dex.paidAt
      ? `since ${new Date(dex.paidAt).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}`
      : "logo, banner and links are live there"
    : dex.state === "pending" ? "order placed, awaiting approval"
    : dex.state === "unpaid" ? "listed, no paid info"
    : "not indexed yet";

  return (
    <div className="dp-panel" style={{ marginTop: 12 }}>
      <div className="dp-phead"><span>DEX Screener</span>
        {dex.url && <a href={dex.url} target="_blank" rel="noreferrer noopener">pair ↗</a>}
      </div>
      <div className="dp-pbody">
        <div className="dp-dexrow">
          <DexBadge profile={dex} title={false} />
          <span className="dp-dexnote">{note}</span>
        </div>
        {dex.state === "paid" && (
          <p className="dp-spec-note" style={{ marginTop: 10 }}>
            Someone paid for this token&apos;s info on DEX Screener, so its logo, banner and links
            render there. That is proof of spend, not of safety.
          </p>
        )}
        {dex.state === "unpaid" && (
          <p className="dp-spec-note" style={{ marginTop: 10 }}>
            No paid token info: on DEX Screener this trades as an unnamed row. Anyone can buy the
            profile — doubleplus does not sell it and takes no cut.
          </p>
        )}
        {dex.state === "unlisted" && (
          <p className="dp-spec-note" style={{ marginTop: 10 }}>
            DEX Screener indexes pools, not curves. The pair appears after graduation.
          </p>
        )}
      </div>
    </div>
  );
}

function ContractCard({ v }: { v: VentureT }) {
  const vested = v.vesting !== "0x0000000000000000000000000000000000000000";
  const deployed = new Date(v.createdAt * 1000).toLocaleDateString("en-GB", {
    day: "numeric", month: "short", year: "numeric",
  });
  const rows: [string, React.ReactNode][] = [
    ["deployed", deployed],
    ["raise type", v.mode === 1 ? "open curve" : "all-or-nothing"],
    ["fee policy", `${(v.policy.buyTaxBps / 100).toFixed(2)}% buy · ${(v.policy.sellTaxBps / 100).toFixed(2)}% sell`],
    ["fee split", `${v.policy.devBps / 100} / ${v.policy.dividendBps / 100} / ${v.policy.liquidityBps / 100} / ${v.policy.mmBps / 100}`],
    ["protocol fee", `${(VENTURE.platformFeeBps / 100).toFixed(2)}%`],
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
          Set once, at deployment. There is no admin key, no upgrade path and no owner who can
          rewrite these numbers — the creator included.
        </p>
      </div>
    </div>
  );
}

function WhoEarns({ v }: { v: VentureT }) {
  const avgTax = (v.policy.buyTaxBps + v.policy.sellTaxBps) / 2 / 100;
  const slices: Slice[] = [
    { label: "Founder", value: v.policy.devBps, note: "on every trade, forever" },
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
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [sellQ, setSellQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0n);
  const [bought, setBought] = useState(0n);
  const [fees, setFees] = useState({ buyBps: 0, sellBps: 0 });
  const eth = useBalance({ address: me });

  useEffect(() => {
    const read = (fn: "curveBuyFeeBps" | "curveSellFeeBps") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn });
    Promise.all([read("curveBuyFeeBps"), read("curveSellFeeBps")])
      .then(([b, sl]) => setFees({ buyBps: Number(b), sellBps: Number(sl) })).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!me) return;
    const read = (fn: "spentWei" | "boughtTokens") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn, args: [v.address, me] });
    read("spentWei").then((x) => setSpent(x as bigint)).catch(() => undefined);
    read("boughtTokens").then((x) => setBought(x as bigint)).catch(() => undefined);
  }, [me, v.address, busy]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);
  // The entry fee comes off before the curve is quoted, so the tokens you get
  // are priced on what actually reaches the curve.
  const entryFee = (parsed * BigInt(fees.buyBps)) / 10_000n;
  const tokensOut = quoteTokens(v, parsed - entryFee);
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const capLeft = v.maxBuyWei > spent ? v.maxBuyWei - spent : 0n;
  const overCap = v.maxBuyWei > 0n && parsed > capLeft;
  const shortOnEth = eth.data !== undefined && parsed > eth.data.value;
  const ethUsdInPanel = useEthUsd();

  const ownedWhole = bought / 10n ** 18n;
  const sellWhole = useMemo(() => {
    const n = BigInt(Math.floor(Number(sellQ) || 0));
    return n > ownedWhole ? ownedWhole : n < 0n ? 0n : n;
  }, [sellQ, ownedWhole]);
  const sellQuote = useMemo(
    () => quoteSellWei(v, sellWhole, bought, spent, fees.sellBps),
    [v, sellWhole, bought, spent, fees.sellBps],
  );

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

  const sell = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || sellWhole === 0n) return;
    setBusy(true);
    try {
      const need = sellWhole * 10n ** 18n;
      const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.factory] })) as bigint;
      if (allowance < need) {
        const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.factory, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
        await venturePc.waitForTransactionReceipt({ hash: a });
      }
      // 1% tolerance: the curve can move between quote and mine.
      const minOut = (sellQuote.out * 9_900n) / 10_000n;
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "sell", args: [v.address, sellWhole, minOut], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Exit submitted", txHash: hash });
      await venturePc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Sold back to the curve", txHash: hash });
      setSellQ("");
    } catch (e) {
      pushToast({ kind: "error", title: "Sell failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const guaranteed = v.mode === 0;

  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>
          {guaranteed ? "Back this raise" : "Buy"}
        </button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>Sell back</button>
      </div>
      <div className="dp-tb-body">
        <ReferralBanner />
        {side === "buy" ? (
          <>
            <div className="dp-tb-amt">
              <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span>ETH</span>
            </div>
            <div className="dp-quicks">
              {["0.05", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)}
            </div>
            <p className="dp-tb-est">
              {tokensOut > 0n ? <>you receive ≈ <b>{fmtTok(tokensOut, true)} ${v.symbol}</b></> : <>enter an amount to see what you get</>}
            </p>
            <button className="dp-tb-go dp-buy"
              disabled={busy || overCap || shortOnEth || (isConnected && parsed === 0n)} onClick={buy}>
              {busy ? "Confirm in wallet…"
                : !isConnected ? "Connect wallet"
                : shortOnEth ? "Not enough ETH"
                : overCap ? "Over your wallet cap"
                : guaranteed ? `Back ${v.name}` : `Buy $${v.symbol}`}
            </button>
            <div className="dp-tb-slip">
              <span>balance <b style={{ color: "var(--dim)" }}>{eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH</b></span>
              <span>entry fee {(fees.buyBps / 100).toFixed(2)}%{entryFee > 0n ? ` · ${fmtEth(entryFee, 5)} ETH` : ""}</span>
            </div>
          </>
        ) : (
          <>
            <div className="dp-tb-amt">
              <input inputMode="numeric" placeholder="0" value={sellQ} onChange={(e) => setSellQ(e.target.value.replace(/[^0-9]/g, ""))} />
              <span>${v.symbol}</span>
            </div>
            <div className="dp-quicks">
              {([["25%", 4n], ["50%", 2n], ["Max", 1n]] as const).map(([label, div]) => (
                <button key={label} onClick={() => setSellQ(String(ownedWhole / div))}>{label}</button>
              ))}
            </div>
            <p className="dp-tb-est">
              {sellQuote.out > 0n
                ? <>you receive ≈ <b>{fmtEth(sellQuote.out, 5)} ETH</b></>
                : <>you hold {fmtTok(bought)} ${v.symbol} from the curve</>}
            </p>
            <button className="dp-tb-go dp-sell"
              disabled={busy || (isConnected && sellWhole === 0n)} onClick={sell}>
              {busy ? "Confirm in wallet…" : !isConnected ? "Connect wallet" : `Sell ${fmtTok(sellWhole, true)} $${v.symbol}`}
            </button>
            <div className="dp-tb-slip">
              <span>your curve position <b style={{ color: "var(--dim)" }}>{fmtTok(bought)}</b></span>
              <span>exit fee {(fees.sellBps / 100).toFixed(2)}%</span>
            </div>
          </>
        )}
        <div className="dp-tb-slip">
          <span>{guaranteed ? <>closes in <Countdown deadline={v.deadline} /></> : <>no deadline — graduates on the curve</>}</span>
          <span>{ethUsdInPanel > 0 && parsed > 0n && side === "buy" ? fmtUsdV((Number(parsed) / 1e18) * ethUsdInPanel) : ""}</span>
        </div>
        <p className="dp-tb-note">
          {side === "sell" && guaranteed
            ? "Exit any time. Before graduation the curve pays back up to what you put in."
            : side === "sell"
            ? "Exit any time, at the live curve price."
            : guaranteed
            ? "All-or-nothing. Miss the target and your curve spend comes back."
            : "No target, no deadline. It graduates once the curve fills."}
        </p>
      </div>
      {guaranteed && (
        <div className="dp-gradblock dp-chartrow">
          <Ring pct={funded} size={104} label="funded" />
          <div style={{ flex: 1, minWidth: 140 }}>
            <p style={{ margin: 0, fontSize: 12, color: "var(--dim)" }}>
              <b style={{ color: "var(--text)" }}>{fmtEth(v.targetRaiseWei - (v.raisedWei > v.targetRaiseWei ? v.targetRaiseWei : v.raisedWei), 3)} ETH</b> to go.
            </p>
            <p style={{ margin: "6px 0 0" }}>At 100% it graduates: liquidity locks and trading opens.</p>
          </div>
        </div>
      )}
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
          Closed below target. Return your ${v.symbol} and take your curve spend back. The founder
          allocation is burned.
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
  const [slipBps, setSlipBps] = useState(100);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const eth = useBalance({ address: me });

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

  // The router returns what a trade would produce, so the quote and the
  // slippage floor are both real rather than decorative.
  useEffect(() => {
    if (parsed === 0n) { setQuote(null); return; }
    let live = true;
    setQuoting(true);
    const id = setTimeout(() => {
      const account = me ?? VENTURE.router;
      const sim = side === "buy"
        ? venturePc.simulateContract({ address: VENTURE.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", 0n], value: parsed, account })
        : venturePc.simulateContract({ address: VENTURE.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", 0n], account });
      sim.then((r) => { if (live) setQuote(r.result as bigint); })
        .catch(() => { if (live) setQuote(null); })
        .finally(() => { if (live) setQuoting(false); });
    }, 350);
    return () => { live = false; clearTimeout(id); };
  }, [parsed, side, v.address, me]);

  const minOut = quote !== null ? (quote * BigInt(10_000 - slipBps)) / 10_000n : 0n;
  const shortOnEth = side === "buy" && eth.data !== undefined && parsed > eth.data.value;
  const shortOnTokens = side === "sell" && parsed > bal;

  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      let hash: `0x${string}`;
      if (side === "buy") {
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", minOut], value: parsed, chain: wc.chain, account: wc.account });
      } else {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.router] })) as bigint;
        if (allowance < parsed) {
          const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.router, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await venturePc.waitForTransactionReceipt({ hash: a });
        }
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", minOut], chain: wc.chain, account: wc.account });
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
        <p className="dp-tb-est">
          {parsed === 0n ? <span style={{ color: "var(--faint)" }}>Enter an amount to see what you get.</span>
            : quoting ? <span style={{ color: "var(--faint)" }}>Quoting…</span>
            : quote === null ? <span style={{ color: "var(--down)" }}>Could not quote this trade.</span>
            : side === "buy" ? <>you receive ≈ <b>{fmtTok(quote)} ${v.symbol}</b></>
            : <>you receive ≈ <b>{fmtEth(quote, 6)} ETH</b></>}
        </p>
        <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`}
          disabled={busy || shortOnEth || shortOnTokens || (isConnected && (parsed === 0n || quote === null))} onClick={go}>
          {busy ? "Confirm in wallet…"
            : !isConnected ? "Connect wallet"
            : shortOnEth ? "Not enough ETH"
            : shortOnTokens ? `Not enough $${v.symbol}`
            : `${side === "buy" ? "Buy" : "Sell"} $${v.symbol}`}
        </button>
        <div className="dp-tb-slip">
          <span>
            balance{" "}
            <b style={{ color: "var(--dim)" }}>
              {side === "buy" ? `${eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH` : `${fmtTok(bal)} $${v.symbol}`}
            </b>
          </span>
          <span>fee {(tax / 100).toFixed(1)}% + {(VENTURE.platformFeeBps / 100).toFixed(1)}%</span>
        </div>
        <div className="dp-tb-slip">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            max slippage
            <select value={slipBps} onChange={(e) => setSlipBps(Number(e.target.value))} className="dp-slip">
              <option value={50}>0.5%</option>
              <option value={100}>1%</option>
              <option value={300}>3%</option>
              <option value={500}>5%</option>
            </select>
          </label>
          <span>{quote !== null ? <>min received {side === "buy" ? `${fmtTok(minOut)} $${v.symbol}` : `${fmtEth(minOut, 6)} ETH`}</> : "enforced on-chain"}</span>
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
      <div className="dp-phead"><span>Founder stake · vesting</span><span>{vestedPct.toFixed(0)}% unlocked so far</span></div>
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
