import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { type Venture } from "./client";
import { ago, CurveBar, fmtEth, fmtMcap, Monogram, pct, short, StatusBadge, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";

type Filter = "all" | "research" | "startup" | "raising" | "soon" | "graduated" | "failed";
type Sort = "new" | "mcap" | "funded";

const isResearch = (v: Venture) => /research|science|lab|open.?source|academic/i.test(v.meta.sector ?? "");

/** The board: day-zero raises, densest-first, in launchpad grammar. */
export function Board() {
  const ventures = useVentures();
  const ethUsd = useEthUsd();
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("new");

  const shown = useMemo(() => {
    let list = [...(ventures ?? [])];
    if (filter === "research") list = list.filter(isResearch);
    if (filter === "startup") list = list.filter((v) => !isResearch(v));
    if (filter === "raising") list = list.filter((v) => v.phase === "raising");
    if (filter === "soon") list = list.filter((v) => v.phase === "expired" || (v.phase === "raising" && pct(v.raisedWei, v.targetRaiseWei) >= 85));
    if (filter === "graduated") list = list.filter((v) => v.phase === "graduated");
    if (filter === "failed") list = list.filter((v) => v.phase === "failed");
    if (sort === "mcap") list.sort((a, b) => (b.priceWei > a.priceWei ? 1 : b.priceWei < a.priceWei ? -1 : 0));
    if (sort === "funded") list.sort((a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei));
    if (sort === "new") list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [ventures, filter, sort]);

  // The featured slot is earned: the open raise closest to graduating.
  const featured = useMemo(() => {
    const open = (ventures ?? []).filter((v) => v.phase === "raising" || v.phase === "expired");
    return open.sort((a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei))[0] ?? null;
  }, [ventures]);

  return (
    <div className="dp-shell" style={{ paddingBottom: 60 }}>
      <div className="dp-boardhead" style={{ display: "block", paddingBottom: 6 }}>
        <h1 style={{ fontSize: "clamp(24px, 3.2vw, 34px)", maxWidth: "30ch", lineHeight: 1.15 }}>
          Day-zero funding for startups and research projects.
        </h1>
        <p className="dp-sub" style={{ maxWidth: "78ch", marginTop: 8, fontSize: 13 }}>
          Each raise issues a <b style={{ color: "var(--paper)" }}>decentralized, security-style stock</b> on
          Robinhood Chain — a primary market for ideas, not a meme board. Terms are sworn on-chain before the
          first wei moves; a raise that misses its target refunds every backer in full; graduated stocks pay ETH
          dividends out of real fee flow.
        </p>
      </div>

      <div className="dp-three-col" style={{ margin: "14px 0 18px" }}>
        <Pillar k="Sworn terms" body="Target, founder cut, vesting, taxes — published on-chain before anyone commits, immutable after. The term sheet is the prospectus." />
        <Pillar k="All-or-nothing raises" body="Miss the deadline and every backer is refunded in full while the founder stake burns. Funding is earned, never taken." />
        <Pillar k="Dividends, not promises" body="Graduated stocks pay ETH dividends from trading fees every 15 minutes; liquidity is locked and market-made on both sides by the protocol." />
      </div>

      {featured && <Featured v={featured} ethUsd={ethUsd} />}

      <div className="dp-chips">
        {([["all", "All"], ["startup", "Startups"], ["research", "Research"], ["raising", "Raising"], ["soon", "About to graduate"], ["graduated", "Trading"], ["failed", "Failed"]] as [Filter, string][]).map(([k, label]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <span className="dp-sep" />
        {([["new", "Newest"], ["mcap", "Market cap"], ["funded", "% funded"]] as [Sort, string][]).map(([k, label]) => (
          <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{label}</button>
        ))}
      </div>

      {ventures === null ? (
        <p className="dp-agate" style={{ padding: "40px 0", textAlign: "center" }}>Reading the board…</p>
      ) : shown.length === 0 ? (
        <EmptyBoard any={ventures.length > 0} />
      ) : (
        <div className="dp-grid">{shown.map((v) => <TokenCard key={v.address} v={v} ethUsd={ethUsd} />)}</div>
      )}
    </div>
  );
}

function Pillar({ k, body }: { k: string; body: string }) {
  return (
    <div className="dp-record">
      <span className="dp-k">{k}</span>
      <p className="dp-foot" style={{ fontSize: 11.5, color: "var(--dim)", marginTop: 6 }}>{body}</p>
    </div>
  );
}

function Featured({ v, ethUsd }: { v: Venture; ethUsd: number }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  return (
    <Link className="dp-king" to={`/venture/${v.address}`} viewTransition>
      <Monogram v={v} size="lg" />
      <span>
        <span className="dp-mono" style={{ fontSize: 9.5, letterSpacing: ".18em", color: "var(--red)" }}>
          {v.phase === "expired" ? "FULLY FUNDED" : "CLOSEST TO GRADUATION"}
        </span>
        <h3>{v.name} · ${v.symbol}</h3>
        <span className="dp-meta">
          {v.meta.pitch || v.meta.description || "No pitch filed."} — by {short(v.creator)}
        </span>
        <div className="dp-curvebar" style={{ maxWidth: 420, ["--pct" as string]: `${funded}%` }}><i /></div>
      </span>
      <span className="dp-num">
        <b style={{ fontSize: 20, color: "var(--up)" }}>{funded.toFixed(0)}%</b><br />
        <span style={{ color: "var(--faint)", fontSize: 10.5 }}>
          {fmtEth(v.raisedWei, 3)} / {fmtEth(v.targetRaiseWei, 3)} ETH
        </span>
        <br /><span style={{ color: "var(--faint)", fontSize: 10.5 }}>mcap {fmtMcap(v, ethUsd)}</span>
      </span>
    </Link>
  );
}

function TokenCard({ v, ethUsd }: { v: Venture; ethUsd: number }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const pitch = v.meta.pitch || v.meta.description || "";
  return (
    <Link className="dp-tcard" to={`/venture/${v.address}`} viewTransition>
      <div className="dp-row1">
        <Monogram v={v} />
        <div style={{ minWidth: 0 }}>
          <h3>{v.name}</h3>
          <span className="dp-tick">${v.symbol}{v.meta.sector ? ` · ${v.meta.sector}` : ""}</span>
        </div>
        <span style={{ marginLeft: "auto", alignSelf: "flex-start" }}><StatusBadge v={v} /></span>
      </div>

      <p className="dp-pitch">{pitch}</p>

      {v.phase === "graduated" ? (
        <>
          <div className="dp-facts"><span className="dp-mc">mcap {fmtMcap(v, ethUsd)}</span><span>liquidity locked</span></div>
          <CurveBar v={v} />
          <div className="dp-curvelabel"><span><b>graduated</b> · trading live</span><span>{fmtEth(v.raisedWei, 3)} ETH raised</span></div>
        </>
      ) : v.phase === "failed" ? (
        <>
          <CurveBar v={v} />
          <div className="dp-curvelabel"><span>closed at {funded.toFixed(0)}%</span><span>refunds open</span></div>
        </>
      ) : (
        <>
          <CurveBar v={v} />
          <div className="dp-curvelabel">
            <span><b>{funded.toFixed(0)}%</b> to graduation</span>
            <span>{fmtEth(v.raisedWei, 3)} / {fmtEth(v.targetRaiseWei, 3)} ETH</span>
          </div>
        </>
      )}

      <div className="dp-prov">
        <span>by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago</span>
        <span>mcap {fmtMcap(v, ethUsd)}</span>
      </div>
    </Link>
  );
}

function EmptyBoard({ any }: { any: boolean }) {
  return (
    <div className="dp-panel" style={{ padding: "44px 20px", textAlign: "center" }}>
      <h3 style={{ fontSize: 18, color: "var(--paper)" }}>{any ? "Nothing matches that filter." : "No raises filed yet."}</h3>
      <p className="dp-agate" style={{ marginTop: 6 }}>
        {any ? "Clear the filter to see the whole board." : "The board fills the moment someone files the first raise."}
      </p>
      {!any && <Link className="dp-action" style={{ marginTop: 16 }} to="/launch" viewTransition>Launch your idea</Link>}
    </div>
  );
}
