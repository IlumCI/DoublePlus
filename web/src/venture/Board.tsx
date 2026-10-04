import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { type Venture } from "./client";
import { usePageMeta } from "./seo";
import { ago, CardSkeletons, fmtEth, fmtMcap, Monogram, pct, short, useEthUsd } from "./ui";
import { useUi } from "../store";
import { useVentures } from "./useVentures";
import { useLiveFeed, type FeedItem } from "./feed";
import { useCurveStats, type CurveStats } from "./boardStats";
import { chainNowSecs } from "./clock";

type Filter = "all" | "raising" | "soon" | "graduated";
type Col = "age" | "mcap" | "progress" | "bought" | "buyers";

const FILTERS: [Filter, string][] = [
  ["all", "All"], ["raising", "Filling"], ["soon", "Almost full"], ["graduated", "Trading"],
];

/** The board, as an Explorer details view: one row per coin, columns you
 *  sort by clicking their header. View, sort and search live in the URL so
 *  any view is a link. The address bar's search box feeds `q`. */
export function Board() {
  const { ventures, error, retry } = useVentures();
  const ethUsd = useEthUsd();
  const [params, setParams] = useSearchParams();
  const feed = useLiveFeed();
  const curve = useCurveStats();
  // ETH bought per coin over the last hour: what "trending" actually means.
  const bought1h = useMemo(() => {
    const cutoff = chainNowSecs() - 3600;
    const m = new Map<string, bigint>();
    for (const i of feed.items) if (i.kind === "buy" && i.ts >= cutoff) m.set(i.token.toLowerCase(), (m.get(i.token.toLowerCase()) ?? 0n) + i.eth);
    return m;
  }, [feed.items]);
  usePageMeta(null);
  useGraduationToasts(ventures, feed.items, feed.loaded);

  const filter = (params.get("show") as Filter) || "all";
  const col = (params.get("sort") as Col) || "age";
  const asc = params.get("dir") === "asc";
  const q = params.get("q") ?? "";

  const set = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) if (v === null) next.delete(k); else next.set(k, v);
    setParams(next, { replace: true });
  };
  const sortBy = (c: Col) => set(c === col ? { dir: asc ? null : "asc" } : { sort: c === "age" ? null : c, dir: null });

  const shown = useMemo(() => {
    let list = [...(ventures ?? [])];
    if (filter === "raising") list = list.filter((v) => v.phase === "raising");
    if (filter === "soon") list = list.filter((v) => v.phase === "expired" || (v.phase === "raising" && pct(v.raisedWei, v.targetRaiseWei) >= 85));
    if (filter === "graduated") list = list.filter((v) => v.phase === "graduated");
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((v) =>
        v.name.toLowerCase().includes(needle) || v.symbol.toLowerCase().includes(needle) ||
        (v.meta.pitch ?? "").toLowerCase().includes(needle) || v.address.toLowerCase().includes(needle));
    }
    const key = (v: Venture): number => {
      const k = v.address.toLowerCase();
      if (col === "mcap") return Number(v.priceWei);
      if (col === "progress") return v.phase === "graduated" ? 101 : v.phase === "failed" ? -1 : pct(v.raisedWei, v.targetRaiseWei);
      if (col === "bought") return Number(bought1h.get(k) ?? 0n);
      if (col === "buyers") return curve.get(k)?.buyers ?? 0;
      return v.createdAt;
    };
    list.sort((a, b) => (asc ? key(a) - key(b) : key(b) - key(a)) || b.createdAt - a.createdAt);
    return list;
  }, [ventures, filter, col, asc, q, bought1h, curve]);

  const Th = ({ c, children, num }: { c?: Col; children: React.ReactNode; num?: boolean }) => (
    <span role="columnheader" className={`${num ? "n" : ""}${c === col ? " on" : ""}`}
      aria-sort={c === col ? (asc ? "ascending" : "descending") : undefined}>
      {c ? <button onClick={() => sortBy(c)}>{children}{c === col ? (asc ? " ▴" : " ▾") : ""}</button> : children}
    </span>
  );

  return (
    <div className="dp-shell dp-board">
      <div className="lh-cmdbar">
        <Link className="lh-cmd lh-cmd-go" to="/launch" viewTransition>Launch a coin</Link>
        <span className="lh-cmdsep" />
        <span className="lh-cmdlabel">Show</span>
        {FILTERS.map(([k, label]) => (
          <button key={k} className={`lh-cmd${filter === k ? " on" : ""}`} onClick={() => set({ show: k === "all" ? null : k })}>{label}</button>
        ))}
        <Link className="lh-cmd lh-cmd-end" to="/docs" viewTransition>How it works</Link>
      </div>

      <Ticker ventures={ventures} feed={feed.items} />

      {q && (
        <p className="dp-searchnote">
          {shown.length} result{shown.length === 1 ? "" : "s"} for “{q}”.{" "}
          <button onClick={() => set({ q: null })}>Clear search</button>
        </p>
      )}

      {error && ventures === null ? (
        <div className="dp-notice dp-bad">
          <h3>Can't reach Robinhood Chain.</h3>
          <p>The list is read straight from the chain, and the RPC isn't answering. Your wallet and funds are unaffected.</p>
          <button className="dp-action" style={{ marginTop: 12 }} onClick={retry}>Try again</button>
        </div>
      ) : ventures === null ? (
        <CardSkeletons />
      ) : shown.length === 0 ? (
        <EmptyBoard any={ventures.length > 0} onClear={() => setParams(new URLSearchParams(), { replace: true })} />
      ) : (
        <div className="lh-list" role="table" aria-label="Coins">
          <div className="lh-dhead" role="row">
            <Th>Name</Th>
            <Th c="progress">Stage</Th>
            <Th c="mcap" num>Market cap</Th>
            <Th c="bought" num>Bought, 1h</Th>
            <Th c="buyers" num>Buyers</Th>
            <Th num>Top 10</Th>
            <Th num>Dev</Th>
            <Th c="age" num>Age</Th>
          </div>
          {shown.map((v) => (
            <Row key={v.address} v={v} ethUsd={ethUsd} bought={bought1h.get(v.address.toLowerCase()) ?? 0n} stats={curve.get(v.address.toLowerCase())} />
          ))}
        </div>
      )}
    </div>
  );
}

/** Tape amounts: small trades keep two significant digits instead of rounding to 0. */
function tapeEth(wei: bigint): string {
  const n = Number(wei) / 1e18;
  if (n >= 1) return n.toFixed(2);
  if (n >= 0.001) return n.toFixed(3);
  return n > 0 ? n.toPrecision(2) : "0";
}

const VERB: Record<FeedItem["kind"], string> = { buy: "bought", sell: "sold", launch: "launched", graduate: "graduated" };

/** The latest few events on one line, newest first. Quiet chain, quiet line. */
function Ticker({ ventures, feed }: { ventures: Venture[] | null; feed: FeedItem[] }) {
  const byAddr = useMemo(() => new Map((ventures ?? []).map((v) => [v.address.toLowerCase(), v])), [ventures]);
  const items = feed.filter((i) => byAddr.has(i.token.toLowerCase())).slice(0, 6);
  if (items.length === 0) return null;
  const latest = items[0].key;
  return (
    <div className="dp-ticker" aria-label="Latest activity">
      <span className="dp-ticker-h">Latest</span>
      {items.map((i) => {
        const v = byAddr.get(i.token.toLowerCase())!;
        return (
          <Link key={i.key} to={`/venture/${v.address}`} viewTransition className={`dp-t-${i.kind}${i.key === latest ? " dp-tape-new" : ""}`}>
            {i.who ? <span className="dp-mono">{short(i.who)}</span> : null} {VERB[i.kind]}
            {i.kind === "buy" || i.kind === "sell" ? <> <b className="dp-mono">{tapeEth(i.eth)} ETH</b> of</> : null}
            {" "}<b>${v.symbol}</b> <span className="dp-ticker-ago">{ago(i.ts)} ago</span>
          </Link>
        );
      })}
    </div>
  );
}

/** A graduation that lands while the board is open gets one toast. History
 *  already on the tape when the page loaded stays quiet. */
function useGraduationToasts(ventures: Venture[] | null, feed: FeedItem[], loaded: boolean) {
  const seen = useRef<Set<string> | null>(null);
  const pushToast = useUi((s) => s.pushToast);
  useEffect(() => {
    if (!loaded) return;
    const grads = feed.filter((i) => i.kind === "graduate");
    if (seen.current === null) { seen.current = new Set(grads.map((g) => g.key)); return; }
    for (const g of grads) {
      if (seen.current.has(g.key)) continue;
      seen.current.add(g.key);
      const v = ventures?.find((x) => x.address.toLowerCase() === g.token.toLowerCase());
      if (v) pushToast({ kind: "success", title: `$${v.symbol} graduated`, body: "Its Uniswap pool is open for trading." });
    }
  }, [feed, loaded, ventures, pushToast]);
}

/** One coin, one row. */
function Row({ v, ethUsd, bought, stats: curveStats }: { v: Venture; ethUsd: number; bought: bigint; stats?: CurveStats }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const left = v.targetRaiseWei > v.raisedWei ? v.targetRaiseWei - v.raisedWei : 0n;
  const flash = useFlashOnChange(v.raisedWei);
  let stats = curveStats;
  const pctTxt = (n: number) => `${n < 10 ? n.toFixed(1) : n.toFixed(0)}%`;
  if (v.phase === "failed") stats = undefined; // a refunded raise has no holders to profile
  // Concentration means little with a handful of buyers; flag it once there is a crowd.
  const concentrated = stats && stats.buyers >= 10 && stats.top10Pct > 70;
  return (
    <Link role="row" className={`lh-drow${flash ? " dp-flash" : ""}`} to={`/venture/${v.address}`} viewTransition>
      <span role="cell" className="lh-dname">
        <Monogram v={v} />
        <span>
          <b>{v.name}</b>
          <small>${v.symbol}{v.meta.pitch ? ` · ${v.meta.pitch}` : ""}</small>
        </span>
      </span>
      <span role="cell" className="lh-dstage">
        {v.phase === "graduated" ? <span className="lh-st lh-st-trade">Trading</span>
          : v.phase === "failed" ? <span className="lh-st lh-st-fail" title="Missed its target. Backers can take their ETH back.">Refunding</span>
          : <>
              <span className="lh-dmeter"><i style={{ width: `${Math.min(100, funded)}%` }} /></span>
              <span className="lh-st" title={v.mode === 1 ? "Open curve: no target date, no refund" : "Refunds everyone if it misses its target"}>{funded.toFixed(0)}% · {fmtEth(left, 3)} ETH left</span>
            </>}
      </span>
      <span role="cell" className="n">{v.phase === "failed" ? "" : fmtMcap(v, ethUsd)}</span>
      <span role="cell" className="n">{bought > 0n ? `${tapeEth(bought)} ETH` : ""}</span>
      <span role="cell" className="n">{stats ? stats.buyers : ""}</span>
      <span role="cell" className={`n${concentrated ? " lh-warn" : ""}`}>{stats && stats.buyers > 0 ? pctTxt(stats.top10Pct) : ""}</span>
      <span role="cell" className={`n${stats && stats.devPct > 10 ? " lh-bad" : ""}`} title={stats?.sniped ? "Someone bought in the launch block" : undefined}>
        {stats ? pctTxt(stats.devPct) : ""}{stats?.sniped ? " · sniped" : ""}
      </span>
      <span role="cell" className="n">{ago(v.createdAt)}</span>
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
      <h3>{any ? "No coins in this view." : "No coins yet."}</h3>
      <p>{any ? "Try another view, or clear the search." : "Launch the first one from the bar above."}</p>
      {any && <button className="dp-action" style={{ marginTop: 14 }} onClick={onClear}>Show all coins</button>}
    </div>
  );
}
