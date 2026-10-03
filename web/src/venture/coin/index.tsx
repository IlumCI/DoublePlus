import { useEffect, useState } from "react";
import { Link, useParams, useSearchParams } from "react-router-dom";
import { isAddress } from "viem";

import { NotListed, loadFills, loadVenture, type Fill, type Venture as VentureT } from "../client";
import { useDexProfile } from "../../lib/dexscreener";
import { PriceChart, TradeTape, usePoolTrades } from "../Chart";
import { ShareBar } from "../share";
import { Comments, COMMENTS_ENABLED } from "../comments";
import { usePageMeta } from "../seo";
import { ago, safeImageUrl, DexBadge, fmtMcap, Monogram, short, StatusBadge, useEthUsd } from "../ui";
import { FailPanel, GraduatePanel } from "./ClosedPanels";
import { CurvePanel } from "./CurvePanel";
import { AlertToggle, Socials, StatBar, YourBag } from "./Header";
import { RaisePanel } from "./RaisePanel";
import { TradePanel } from "./TradePanel";
import { BackersPane, ContractCard, ProjectPane, TermsPane, UpdatesPane, VestingCard, WhoEarns } from "./panes";

type Tab = "project" | "chat" | "updates" | "trades" | "backers" | "terms";

export function VenturePage() {
  const { address } = useParams<{ address: string }>();
  const [v, setV] = useState<VentureT | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  // "missing": not an address, or not a coin from this factory. "down": the
  // chain didn't answer; polling keeps trying and the button retries now.
  const [state, setState] = useState<"loading" | "missing" | "down">("loading");
  const [attempt, setAttempt] = useState(0);
  const ethUsd = useEthUsd();
  const coin = address && isAddress(address) ? address : null;

  useEffect(() => {
    if (!coin) { setState("missing"); return; }
    let live = true;
    const refresh = () => {
      loadVenture(coin)
        .then((x) => { if (live) { setV(x); setState("loading"); } })
        .catch((e) => { if (live) setState(e instanceof NotListed ? "missing" : "down"); });
      loadFills(coin).then((f) => live && setFills(f)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 10_000);
    return () => { live = false; clearInterval(id); };
  }, [coin, attempt]);

  usePageMeta(v ? `${v.name} ($${v.symbol})` : null, v?.meta.pitch);

  if (!v) {
    if (state === "missing") {
      return (
        <div className="dp-notice" style={{ margin: "40px 18px", textAlign: "center" }}>
          <h3>No coin at this address.</h3>
          <p>It isn't a coin launched on doubleplus. Check the link, or find it in the list.</p>
          <Link className="dp-action" style={{ display: "inline-block", marginTop: 12 }} to="/" viewTransition>All coins</Link>
        </div>
      );
    }
    if (state === "down") {
      return (
        <div className="dp-notice dp-bad" style={{ margin: "40px 18px", textAlign: "center" }}>
          <h3>Can't reach Robinhood Chain.</h3>
          <p>The coin is read straight from the chain, and the RPC isn't answering. Your wallet and funds are unaffected.</p>
          <button className="dp-action" style={{ marginTop: 12 }} onClick={() => { setState("loading"); setAttempt((n) => n + 1); }}>Try again</button>
        </div>
      );
    }
    return <div className="dp-shell" style={{ padding: "80px 18px", textAlign: "center", color: "var(--faint)" }}>Loading…</div>;
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

  const TABS: [Tab, string][] = [
    ["project", "About"],
    ...(COMMENTS_ENABLED ? ([["chat", "Chat"]] as [Tab, string][]) : []),
    ["updates", "Updates"],
    ...(v.phase === "graduated" ? ([["trades", "Trades"]] as [Tab, string][]) : []),
    ["backers", "Backers"],
    ["terms", "Terms"],
  ];

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>

      {safeImageUrl(v.meta.banner) && (
        <div className="dp-banner"><img src={safeImageUrl(v.meta.banner)} alt="" loading="lazy" referrerPolicy="no-referrer" /></div>
      )}

      <div className="dp-coinhead">
        <Monogram v={v} size="lg" />
        <div style={{ minWidth: 0 }}>
          <h1>{v.name} <span className="dp-mono" style={{ fontSize: 14, color: "var(--dim)" }}>${v.symbol}</span></h1>
          {(v.meta.pitch || v.meta.description) && <p className="dp-oneliner">{v.meta.pitch || v.meta.description}</p>}
          <p className="dp-prov" style={{ margin: "4px 0 0" }}>
            created by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago
            {v.meta.sector ? <> · {v.meta.sector}</> : null} · <StatusBadge v={v} /> <DexBadge profile={dex} /> <AlertToggle v={v} />
          </p>
          <Socials meta={v.meta} dex={dex} />
        </div>
        <div className="dp-mcbig">
          {v.phase !== "failed" && <>
            <span className="dp-k">market cap</span><br />
            <span className="dp-v">{fmtMcap(v, ethUsd)}</span><br />
          </>}
          <YourBag v={v} />
        </div>
      </div>

      {v.phase === "graduated" && <StatBar trades={trades} ethUsd={ethUsd} />}

      <div className="dp-coingrid">
        {/* LEFT: the market, then everything that justifies it */}
        <div className="dp-coinmain">
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
          {COMMENTS_ENABLED && <div className="dp-tabpane" hidden={tab !== "chat"}><Comments v={v} /></div>}
          <div className="dp-tabpane" hidden={tab !== "updates"}><UpdatesPane v={v} /></div>
          {v.phase === "graduated" && <div className="dp-tabpane" hidden={tab !== "trades"}><TradeTape v={v} trades={trades} /></div>}
          <div className="dp-tabpane" hidden={tab !== "backers"}><BackersPane v={v} fills={fills} /></div>
          <div className="dp-tabpane" hidden={tab !== "terms"}><TermsPane v={v} /><WhoEarns v={v} /><VestingCard v={v} /><ContractCard v={v} /></div>
        </div>

        {/* RIGHT: the money box, always above the fold */}
        <div className="dp-coinside">
          {v.phase === "raising" && <RaisePanel v={v} />}
          {v.phase === "expired" && <GraduatePanel v={v} />}
          {v.phase === "failed" && <FailPanel v={v} />}
          {v.phase === "graduated" && <TradePanel v={v} />}

          <ShareBar v={v} />
        </div>
      </div>
    </div>
  );
}
