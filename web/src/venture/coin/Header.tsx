import { useEffect, useMemo, useState } from "react";

import { factoryAbi, SOCIAL_FIELDS, VENTURE, venturePc, type PoolTrade, type Venture as VentureT } from "../client";
import { marketStats } from "../marketStats";
import { profileLinks, type DexProfile } from "../../lib/dexscreener";
import { loadHolding, type Holding } from "../portfolio";
import { safeLinkUrl } from "../safe";
import { useWatched } from "../alerts";
import { BuySellStrength, Delta, fmtEth, fmtUsdPrice, fmtUsdV, StatCell } from "../ui";
import { useWallet } from "../../lib/useWallet";
import { chainNowSecs } from "../clock";


/** Pre-graduation: the curve itself is the chart. */
/** The project's own channels. A trader checks these before anything else,
 *  so they sit with the name rather than buried in a tab. */
export function Socials({ meta, dex }: { meta: VentureT["meta"]; dex?: DexProfile }) {
  const onChain: { label: string; url: string }[] = SOCIAL_FIELDS
    .map(([key, label]) => ({ label: label as string, url: meta[key] ?? "" }))
    .map((l) => ({ ...l, url: safeLinkUrl(l.url) })).filter((l) => l.url);
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
export function StatBar({ trades, ethUsd }: { trades: PoolTrade[]; ethUsd: number }) {
  const st = useMemo(() => marketStats(trades, chainNowSecs()), [trades]);
  const priceEth = Number(st.priceWei) / 1e18;
  return (
    <>
      <div className="dp-statbar">
        <StatCell k="price">{ethUsd > 0 && priceEth > 0 ? fmtUsdPrice(priceEth * ethUsd) : `${fmtEth(st.priceWei, 8)}`}</StatCell>
        <StatCell k="24h vol">{ethUsd > 0 ? fmtUsdV((Number(st.vol24Wei) / 1e18) * ethUsd) : `${fmtEth(st.vol24Wei, 3)} ETH`}</StatCell>
        <StatCell k="24h txns">{st.buys24 + st.sells24}</StatCell>
        <StatCell k="5m"><Delta pct={st.change.m5} sinceInception={st.ageSecs < 300} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="1h"><Delta pct={st.change.h1} sinceInception={st.ageSecs < 3_600} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="4h"><Delta pct={st.change.h4} sinceInception={st.ageSecs < 14_400} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="24h"><Delta pct={st.change.h24} sinceInception={st.ageSecs < 86_400} ageSecs={st.ageSecs} /></StatCell>
      </div>
      {st.buys24 + st.sells24 > 0 && (
        <div style={{ margin: "-4px 0 14px" }}>
          <BuySellStrength buyWei={st.buyVol24Wei} sellWei={st.sellVol24Wei} buys={st.buys24} sells={st.sells24} />
        </div>
      )}
    </>
  );
}

/** Watch a coin: an alert when it is nearly full, graduates, or opens
 *  refunds, so nobody has to sit on the chart. Off until someone asks. */
export function AlertToggle({ v }: { v: VentureT }) {
  const [on, set] = useWatched(v.address);
  if (v.phase === "graduated" || v.phase === "failed") return null; // nothing left to wait for
  return (
    <button className={`dp-bell${on ? " on" : ""}`} onClick={() => set(!on)}
      title={on ? "Alerts on: nearly full, graduated, refunds open. Click to stop." : "Get an alert when it's nearly full, graduates, or opens refunds"}>
      {on ? "Alerts on" : "Alert me"}
    </button>
  );
}

/** One line under the market cap: what this wallet's bag is worth if it
 *  cashed out now, and how that compares with what it put in. Nothing when
 *  the wallet has no stake, so nobody reads a row of dashes. */
export function YourBag({ v }: { v: VentureT }) {
  const { address: me } = useWallet();
  const [h, setH] = useState<Holding | null>(null);
  useEffect(() => {
    if (!me) { setH(null); return; }
    let live = true;
    const read = () => {
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "curveSellFeeBps" })
        .then((bps) => loadHolding(me, v, Number(bps)))
        .then((x) => { if (live) setH(x); })
        .catch(() => undefined);
    };
    read();
    const id = setInterval(() => { if (!document.hidden) read(); }, 20_000);
    return () => { live = false; clearInterval(id); };
  }, [me, v]);
  if (!h || h.pos.valueNow === null || (h.pos.valueNow === 0n && h.pos.putIn === 0n)) return null;
  const { pnl, pnlPct, valueNow, basis } = h.pos;
  const what = basis === "refund" ? "refund due" : "your bag if sold now";
  return (
    <span className="dp-bag" title={basis === "market" ? "At the pool price, less sell fees. Large bags get less due to price impact." : undefined}>
      <span className="dp-k">{what}</span>{" "}
      <b>{fmtEth(valueNow, 4)} ETH</b>
      {pnl !== null && pnlPct !== null && basis !== "refund" && (
        <span className={pnl >= 0n ? "dp-up" : "dp-down"}> {pnl >= 0n ? "+" : ""}{pnlPct.toFixed(Math.abs(pnlPct) < 10 ? 1 : 0)}%</span>
      )}
    </span>
  );
}
