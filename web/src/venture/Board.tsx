import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { type Venture } from "./client";
import { useDexProfiles, type DexProfile } from "../lib/dexscreener";
import { usePageMeta } from "./seo";
import { ago, CardSkeletons, CurveBar, DexBadge, fmtEth, fmtMcap, fmtUsdV, Monogram, pct, short, StatusBadge, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";
import { hotTokens, useLiveFeed, type FeedItem } from "./feed";

type Filter = "all" | "research" | "startup" | "raising" | "soon" | "graduated" | "dexpaid" | "failed";
type Sort = "new" | "mcap" | "funded";

const FILTERS: [Filter, string][] = [
  ["all", "All"], ["startup", "Startups"], ["research", "Research"],
  ["raising", "Raising"], ["soon", "About to graduate"], ["graduated", "Trading"],
  ["dexpaid", "DEX paid"], ["failed", "Refunding"],
];
const SORTS: [Sort, string][] = [["new", "Newest"], ["mcap", "Market cap"], ["funded", "% funded"]];

const isResearch = (v: Venture) => /research|science|lab|open.?source|academic/i.test(v.meta.sector ?? "");

/** The board. Filters, sort and search live in the URL so any view is a link. */
export function Board() {
  const { ventures, error, retry } = useVentures();
  const ethUsd = useEthUsd();
  // Only graduated ventures have a DEX Screener pair, and the bulk endpoint
  // takes 30 addresses a call, so the whole board costs one or two requests.
  const dexTokens = useMemo(
    () => (ventures ?? []).filter((v) => v.phase === "graduated").map((v) => v.address),
    [ventures]);
  const dex = useDexProfiles(dexTokens);
  const [params, setParams] = useSearchParams();
  const feed = useLiveFeed();
  const hot = useMemo(() => hotTokens(feed.items), [feed.items]);
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
    if (filter === "dexpaid") list = list.filter((v) => dex.get(v.address.toLowerCase())?.state === "paid");
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
  }, [ventures, filter, sort, q, dex]);

  return (
    <div className="dp-shell" style={{ paddingBottom: 60 }}>
      <div className="dp-hero">
        <div>
          <h1>Launch a coin. Fill the curve. <span className="dp-hl">Hit Uniswap.</span></h1>
          <p className="dp-sub">
            Every buy pushes the price up the curve. Fill it and the coin graduates into its own Uniswap pool,
            and every holder gets paid ETH on every trade after that.
          </p>
        </div>
        <div className="dp-hero-cta">
          <Link className="dp-action dp-action-xl" to="/launch" viewTransition>Launch a coin</Link>
          <span className="dp-hero-link">two minutes · one transaction</span>
        </div>
      </div>

      <LiveTape ventures={ventures} feed={feed.items} loaded={feed.loaded} />
      <King ventures={ventures} hot={hot} />
      <Proof ventures={ventures} ethUsd={ethUsd} feed={feed.items} />
      <TrustStrip />

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
        <div className="dp-grid">
          {filter === "all" && !q && <YourCoinCard />}
          {shown.map((v) => <TokenCard key={v.address} v={v} ethUsd={ethUsd} dex={dex.get(v.address.toLowerCase())} hot={hot.has(v.address.toLowerCase())} />)}
        </div>
      )}
    </div>
  );
}

/** The guarantees, kept to one quiet line: the board leads with the action. */
function TrustStrip() {
  return (
    <p className="dp-trust">
      <span>Liquidity locked at graduation</span>
      <span>Terms fixed on-chain</span>
      <span>Raise misses? Curve buyers get their ETH back</span>
      <Link to="/docs" viewTransition>How it works →</Link>
    </p>
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

/** The tape: the latest real launches, buys, sells and graduations. The
 *  newest entry flashes in; a quiet chain shows a quiet tape. */
function LiveTape({ ventures, feed, loaded }: { ventures: Venture[] | null; feed: FeedItem[]; loaded: boolean }) {
  const bySym = useMemo(() => new Map((ventures ?? []).map((v) => [v.address.toLowerCase(), v])), [ventures]);
  const latest = feed[0]?.key;
  if (!loaded) return <div className="dp-tape dp-tape-wait"><span className="dp-tape-live">LIVE</span><span className="dp-tape-quiet">tuning in…</span></div>;
  if (feed.length === 0) return null;
  return (
    <div className="dp-tape" aria-label="Live activity">
      <span className="dp-tape-live">LIVE</span>
      <div className="dp-tape-row">
        {feed.slice(0, 10).map((i) => {
          const v = bySym.get(i.token.toLowerCase());
          if (!v) return null;
          return (
            <Link key={i.key} to={`/venture/${v.address}`} viewTransition
              className={`dp-tape-item dp-t-${i.kind}${i.key === latest ? " dp-tape-new" : ""}`}>
              {i.who ? <span className="dp-tape-who">{short(i.who)}</span> : null}
              <span>{VERB[i.kind]}</span>
              {i.kind === "buy" || i.kind === "sell" ? <b>{tapeEth(i.eth)} ETH</b> : null}
              <span className="dp-tape-sym">${v.symbol}</span>
              <span className="dp-tape-ago">{ago(i.ts)}</span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}

/** King of the hill: the live raise closest to graduation, shown big. */
function King({ ventures, hot }: { ventures: Venture[] | null; hot: Set<string> }) {
  const king = useMemo(() => {
    const live = (ventures ?? []).filter((v) => v.phase === "raising" && v.raisedWei > 0n);
    return live.sort((a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei))[0];
  }, [ventures]);
  if (!king) return null;
  const funded = pct(king.raisedWei, king.targetRaiseWei);
  const left = king.targetRaiseWei > king.raisedWei ? king.targetRaiseWei - king.raisedWei : 0n;
  return (
    <Link className="dp-throne" to={`/venture/${king.address}`} viewTransition>
      <span className="dp-crown" aria-hidden>👑</span>
      <Monogram v={king} size="lg" />
      <div className="dp-throne-main">
        <div className="dp-throne-tag">King of the hill{hot.has(king.address.toLowerCase()) ? " · 🔥 buying now" : ""}</div>
        <h2>{king.name} <span className="dp-tick">${king.symbol}</span></h2>
        <CurveBar v={king} />
        <div className="dp-curvelabel">
          <span><b>{funded.toFixed(0)}%</b> to graduation</span>
          <span>{fmtEth(left, 3)} ETH left to fill</span>
        </div>
      </div>
      <span className="dp-action dp-throne-cta">Ape in →</span>
    </Link>
  );
}

/** Live totals, all read from the chain. */
function Proof({ ventures, ethUsd, feed }: { ventures: Venture[] | null; ethUsd: number; feed: FeedItem[] }) {
  if (!ventures || ventures.length === 0) return null;
  const raised = ventures.reduce((a, v) => a + v.raisedWei, 0n);
  const trading = ventures.filter((v) => v.phase === "graduated").length;
  const raisedEth = Number(raised) / 1e18;
  const weekAgo = Date.now() / 1000 - 7 * 86_400;
  const launches = ventures.filter((v) => v.createdAt >= weekAgo).length;
  const dayAgo = Date.now() / 1000 - 86_400;
  const vol = feed.filter((i) => (i.kind === "buy" || i.kind === "sell") && i.ts >= dayAgo).reduce((a, i) => a + i.eth, 0n);
  const usd = (wei: bigint) => (ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 3)} ETH`);
  return (
    <div className="dp-proof">
      <span className="dp-item"><span className="dp-n">{ethUsd > 0 ? fmtUsdV(raisedEth * ethUsd) : `${fmtEth(raised, 3)} ETH`}</span><span className="dp-l">committed</span></span>
      {vol > 0n && <span className="dp-item"><span className="dp-n">{usd(vol)}</span><span className="dp-l">traded today</span></span>}
      <span className="dp-item"><span className="dp-n">{launches}</span><span className="dp-l">{launches === 1 ? "launch" : "launches"} this week</span></span>
      <span className="dp-item"><span className="dp-n">{trading}</span><span className="dp-l">on Uniswap</span></span>
    </div>
  );
}

/** The empty seat at the front of the board. */
function YourCoinCard() {
  return (
    <Link className="dp-tcard dp-yours" to="/launch" viewTransition>
      <span className="dp-yours-plus" aria-hidden>+</span>
      <h3>Your coin here</h3>
      <p>Name it, set the target, ship it. Two minutes, one transaction.</p>
      <span className="dp-action">Launch a coin</span>
    </Link>
  );
}

function TokenCard({ v, ethUsd, dex, hot }: { v: Venture; ethUsd: number; dex?: DexProfile; hot: boolean }) {
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
        <span style={{ marginLeft: "auto", alignSelf: "flex-start", display: "flex", gap: 4, flexWrap: "wrap", justifyContent: "flex-end" }}>
          {hot && <span className="dp-badge dp-hot" title="Bought in the last 15 minutes">🔥 hot</span>}
          {Date.now() / 1000 - v.createdAt < 86_400 && <span className="dp-badge dp-new">new</span>}
          {dex && <DexBadge profile={dex} />}
          <StatusBadge v={v} />
        </span>
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
      {/* No second Launch button here: the hero's is a few hundred pixels up
          and the topbar carries a third. Only the filter reset is new. */}
      {any && <button className="dp-action" style={{ marginTop: 14 }} onClick={onClear}>Clear filters</button>}
    </div>
  );
}
