import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { type Venture } from "./client";
import { usePageMeta } from "./seo";
import { ago, CardSkeletons, CurveBar, fmtEth, fmtMcap, fmtUsdV, Monogram, pct, short, StatusBadge, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";

type Filter = "all" | "research" | "startup" | "raising" | "soon" | "graduated" | "failed";
type Sort = "new" | "mcap" | "funded";

const FILTERS: [Filter, string][] = [
  ["all", "All"], ["startup", "Startups"], ["research", "Research"],
  ["raising", "Raising"], ["soon", "About to graduate"], ["graduated", "Trading"], ["failed", "Refunding"],
];
const SORTS: [Sort, string][] = [["new", "Newest"], ["mcap", "Market cap"], ["funded", "% funded"]];

const isResearch = (v: Venture) => /research|science|lab|open.?source|academic/i.test(v.meta.sector ?? "");

/** The board. Filters, sort and search live in the URL so any view is a link. */
export function Board() {
  const { ventures, error, retry } = useVentures();
  const ethUsd = useEthUsd();
  const [params, setParams] = useSearchParams();
  usePageMeta(null);

  const filter = (params.get("show") as Filter) || "all";
  const sort = (params.get("sort") as Sort) || "new";
  const q = params.get("q") ?? "";

  const set = (key: string, value: string, fallback: string) => {
    const next = new URLSearchParams(params);
    if (value === fallback) next.delete(key); else next.set(key, value);
    setParams(next, { replace: true });
  };

  const shown = useMemo(() => {
    let list = [...(ventures ?? [])];
    if (filter === "research") list = list.filter(isResearch);
    if (filter === "startup") list = list.filter((v) => !isResearch(v));
    if (filter === "raising") list = list.filter((v) => v.phase === "raising");
    if (filter === "soon") list = list.filter((v) => v.phase === "expired" || (v.phase === "raising" && pct(v.raisedWei, v.targetRaiseWei) >= 85));
    if (filter === "graduated") list = list.filter((v) => v.phase === "graduated");
    if (filter === "failed") list = list.filter((v) => v.phase === "failed");
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((v) =>
        v.name.toLowerCase().includes(needle) || v.symbol.toLowerCase().includes(needle) ||
        (v.meta.pitch ?? "").toLowerCase().includes(needle) || (v.meta.sector ?? "").toLowerCase().includes(needle) ||
        v.address.toLowerCase().includes(needle));
    }
    if (sort === "mcap") list.sort((a, b) => (b.priceWei > a.priceWei ? 1 : b.priceWei < a.priceWei ? -1 : 0));
    else if (sort === "funded") list.sort((a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [ventures, filter, sort, q]);

  return (
    <div className="dp-shell" style={{ paddingBottom: 60 }}>
      <div className="dp-hero">
        <div>
          <h1>Back an idea. Own a stake in its market.</h1>
          <p className="dp-sub">Fund startups and research at day zero. Keep earning after the raise closes.</p>
        </div>
        <div className="dp-hero-cta">
          <Link className="dp-action" to="/launch" viewTransition>Launch your idea</Link>
          <Link className="dp-mono dp-hero-link" to="/docs" viewTransition>See how it works →</Link>
        </div>
      </div>

      <Edge />
      <Proof ventures={ventures} ethUsd={ethUsd} />

      <div className="dp-board-search">
        <input value={q} onChange={(e) => set("q", e.target.value, "")} placeholder="Search projects…" aria-label="Search projects" />
      </div>

      <div className="dp-chips">
        {FILTERS.map(([k, label]) => (
          <button key={k} className={filter === k ? "on" : ""} onClick={() => set("show", k, "all")}>{label}</button>
        ))}
        <span className="dp-sep" />
        {SORTS.map(([k, label]) => (
          <button key={k} className={sort === k ? "on" : ""} onClick={() => set("sort", k, "new")}>{label}</button>
        ))}
      </div>

      {q && (
        <p className="dp-agate" style={{ marginBottom: 10 }}>
          {shown.length} result{shown.length === 1 ? "" : "s"} for “{q}” ·{" "}
          <button style={{ background: "none", border: "none", color: "var(--up)", padding: 0 }}
            onClick={() => set("q", "", "")}>clear</button>
        </p>
      )}

      {error && ventures === null ? (
        <div className="dp-notice dp-bad">
          <h3>Could not reach the chain.</h3>
          <p>The board reads straight from the RPC and it isn't answering right now. Your wallet is fine.</p>
          <button className="dp-action" style={{ marginTop: 12 }} onClick={retry}>Try again</button>
        </div>
      ) : ventures === null ? (
        <CardSkeletons />
      ) : shown.length === 0 ? (
        <EmptyBoard any={ventures.length > 0} onClear={() => setParams(new URLSearchParams(), { replace: true })} />
      ) : (
        <div className="dp-grid">{shown.map((v) => <TokenCard key={v.address} v={v} ethUsd={ethUsd} />)}</div>
      )}
    </div>
  );
}

/** The wedge: what you get here that a meme launchpad cannot give you. */
function Edge() {
  const rows: [string, string, string][] = [
    ["\u25A4", "Terms locked on-chain", "Set at launch. Never editable."],
    ["\u21BA", "Your curve spend back if it misses", "All-or-nothing. Founder stake burns."],
    ["\u25C9", "Holders paid every trade", "In ETH, forever. Liquidity locked."],
  ];
  return (
    <div className="dp-edge">
      {rows.map(([icon, h, b]) => (
        <div className="dp-edge-item" key={h}>
          <span className="dp-edge-icon" aria-hidden>{icon}</span>
          <div><h3>{h}</h3><p>{b}</p></div>
        </div>
      ))}
    </div>
  );
}

/** Strength, not confession: live totals plus the guarantee that always holds. */
function Proof({ ventures, ethUsd }: { ventures: Venture[] | null; ethUsd: number }) {
  if (!ventures || ventures.length === 0) return null;
  const raised = ventures.reduce((a, v) => a + v.raisedWei, 0n);
  const trading = ventures.filter((v) => v.phase === "graduated").length;
  const raisedEth = Number(raised) / 1e18;
  return (
    <div className="dp-proof">
      <span className="dp-item">
        <span className="dp-n">{ethUsd > 0 ? fmtUsdV(raisedEth * ethUsd) : `${fmtEth(raised, 3)} ETH`}</span>
        <span className="dp-l">committed to projects</span>
      </span>
      <span className="dp-item">
        <span className="dp-n">{trading}</span>
        <span className="dp-l">{trading === 1 ? "project trading with locked liquidity" : "projects trading with locked liquidity"}</span>
      </span>
      <span className="dp-item">
        <span className="dp-n">100%</span>
        <span className="dp-l">of what you put in the curve, back if a raise misses</span>
      </span>
    </div>
  );
}

function TokenCard({ v, ethUsd }: { v: Venture; ethUsd: number }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const pitch = v.meta.pitch || v.meta.description || "";
  const flash = useFlashOnChange(v.raisedWei);

  return (
    <Link className={`dp-tcard ${flash ? "dp-flash" : ""}`} to={`/venture/${v.address}`} viewTransition>
      <div className="dp-row1">
        <Monogram v={v} />
        <div style={{ minWidth: 0 }}>
          <h3>{v.name}</h3>
          <span className="dp-tick">${v.symbol}{v.meta.sector ? ` · ${v.meta.sector}` : ""}</span>
        </div>
        <span style={{ marginLeft: "auto", alignSelf: "flex-start" }}><StatusBadge v={v} /></span>
      </div>

      {pitch && <p className="dp-pitch">{pitch}</p>}

      <CurveBar v={v} />
      <div className="dp-curvelabel">
        {v.phase === "graduated" ? (
          <><span>trading · mcap <b>{fmtMcap(v, ethUsd)}</b></span><span>{fmtEth(v.raisedWei, 3)} ETH raised</span></>
        ) : v.phase === "failed" ? (
          <><span>closed at {funded.toFixed(0)}%</span><span>refunds open</span></>
        ) : (
          <><span><b>{funded.toFixed(0)}%</b> to graduation</span><span>{fmtEth(v.raisedWei, 3)} / {fmtEth(v.targetRaiseWei, 3)} ETH</span></>
        )}
      </div>

      <div className="dp-prov">
        <span>by <b>{short(v.creator)}</b> · {ago(v.createdAt)} ago</span>
        <span>founder takes {(v.founderRaiseBps / 100).toFixed(0)}%</span>
      </div>
    </Link>
  );
}

/** Flash a card when its raise actually moves. Nothing animates otherwise. */
function useFlashOnChange(value: bigint): boolean {
  const previous = useRef(value);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (previous.current !== value) {
      previous.current = value;
      setFlash(true);
      const id = setTimeout(() => setFlash(false), 1200);
      return () => clearTimeout(id);
    }
  }, [value]);
  return flash;
}

function EmptyBoard({ any, onClear }: { any: boolean; onClear: () => void }) {
  return (
    <div className="dp-notice" style={{ padding: "36px 22px", textAlign: "center" }}>
      <h3>{any ? "Nothing matches those filters." : "The board is open."}</h3>
      <p>{any ? "Clear them to see every project." : "Be the first project on it — a raise takes one transaction and about two minutes."}</p>
      {any
        ? <button className="dp-action" style={{ marginTop: 14 }} onClick={onClear}>Clear filters</button>
        : <Link className="dp-action" style={{ marginTop: 14 }} to="/launch" viewTransition>Launch your idea</Link>}
    </div>
  );
}
