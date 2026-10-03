import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";

import { type Venture } from "./client";
import { usePageMeta } from "./seo";
import { ago, CardSkeletons, CurveBar, fmtEth, fmtMcap, fmtUsdV, Monogram, pct, short, StatusBadge, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";
import { hotTokens, useLiveFeed, type FeedItem } from "./feed";
import { useCurveStats, type CurveStats } from "./boardStats";

type Filter = "all" | "raising" | "soon" | "graduated";
type Sort = "new" | "trending" | "mcap";

// Few, plain choices: what stage a coin is at, and how to order them.
// Refunds are reached from the portfolio, where the button is.
const FILTERS: [Filter, string][] = [
  ["all", "All"], ["raising", "Filling"], ["soon", "Almost full"], ["graduated", "Trading"],
];
const SORTS: [Sort, string][] = [["new", "Newest"], ["trending", "🔥 Trending"], ["mcap", "Market cap"]];

/** Fresh lane window: launches younger than this get the lane at the top. */
const FRESH_SECS = 86_400;

/** The board. Filters, sort and search live in the URL so any view is a link. */
export function Board() {
  const { ventures, error, retry } = useVentures();
  const ethUsd = useEthUsd();
  const [params, setParams] = useSearchParams();
  const feed = useLiveFeed();
  const curve = useCurveStats();
  const hot = useMemo(() => hotTokens(feed.items), [feed.items]);
  // Buy volume per token over the last hour: the trending sort's only input.
  const heat = useMemo(() => {
    const cutoff = Date.now() / 1000 - 3600;
    const m = new Map<string, bigint>();
    for (const i of feed.items) if (i.kind === "buy" && i.ts >= cutoff) m.set(i.token.toLowerCase(), (m.get(i.token.toLowerCase()) ?? 0n) + i.eth);
    return m;
  }, [feed.items]);
  // Each creator's record across the board: launches and how many graduated.
  const records = useMemo(() => {
    const m = new Map<string, { launched: number; graduated: number }>();
    for (const v of ventures ?? []) {
      const r = m.get(v.creator.toLowerCase()) ?? { launched: 0, graduated: 0 };
      r.launched++;
      if (v.phase === "graduated") r.graduated++;
      m.set(v.creator.toLowerCase(), r);
    }
    return m;
  }, [ventures]);
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
    if (filter === "raising") list = list.filter((v) => v.phase === "raising");
    if (filter === "soon") list = list.filter((v) => v.phase === "expired" || (v.phase === "raising" && pct(v.raisedWei, v.targetRaiseWei) >= 85));
    if (filter === "graduated") list = list.filter((v) => v.phase === "graduated");
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((v) =>
        v.name.toLowerCase().includes(needle) || v.symbol.toLowerCase().includes(needle) ||
        (v.meta.pitch ?? "").toLowerCase().includes(needle) || (v.meta.sector ?? "").toLowerCase().includes(needle) ||
        v.address.toLowerCase().includes(needle));
    }
    if (sort === "trending") {
      const h = (v: Venture) => heat.get(v.address.toLowerCase()) ?? 0n;
      list.sort((a, b) => (h(b) > h(a) ? 1 : h(b) < h(a) ? -1 : b.createdAt - a.createdAt));
    } else if (sort === "mcap") list.sort((a, b) => (b.priceWei > a.priceWei ? 1 : b.priceWei < a.priceWei ? -1 : 0));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list;
  }, [ventures, filter, sort, q, heat]);

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
          <span className="dp-hero-link">earn up to 4% of every trade, forever</span>
        </div>
      </div>

      <LiveTape ventures={ventures} feed={feed.items} loaded={feed.loaded} />
      <GradBurst ventures={ventures} feed={feed.items} loaded={feed.loaded} />
      <King ventures={ventures} hot={hot} />
      {filter === "all" && !q && <FreshLane ventures={ventures} />}
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
          {shown.map((v) => <TokenCard key={v.address} v={v} ethUsd={ethUsd} hot={hot.has(v.address.toLowerCase())} record={records.get(v.creator.toLowerCase())} stats={curve.get(v.address.toLowerCase())} />)}
        </div>
      )}
    </div>
  );
}

/** The guarantees, kept to one quiet line: the board leads with the action. */
function TrustStrip() {
  return (
    <p className="dp-trust">
      <span>Refund or rocket: miss the target, everyone gets their ETH back</span>
      <span>Liquidity locked at graduation</span>
      <span>Dev bags unlock on a public clock</span>
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
      <p>Set your cut: up to <b>4% of every trade, forever</b>. Two minutes, one transaction.</p>
      <span className="dp-action">Launch a coin</span>
    </Link>
  );
}

/** Launches from the last day, newest first, age up front: fresh coins are
 *  where the moves happen. Hidden when nothing launched in the window. */
function FreshLane({ ventures }: { ventures: Venture[] | null }) {
  const fresh = useMemo(() => {
    const cutoff = Date.now() / 1000 - FRESH_SECS;
    return (ventures ?? []).filter((v) => v.createdAt >= cutoff && v.phase !== "failed")
      .sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
  }, [ventures]);
  if (fresh.length === 0) return null;
  return (
    <section className="dp-fresh" aria-label="Just launched">
      <h2 className="dp-fresh-h"><span className="dp-fresh-dot" aria-hidden /> Just launched</h2>
      <div className="dp-fresh-row">
        {fresh.map((v) => {
          const p = v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei);
          return (
            <Link key={v.address} className="dp-fresh-card" to={`/venture/${v.address}`} viewTransition>
              <span className="dp-fresh-age">{ago(v.createdAt)}</span>
              <div className="dp-fresh-id"><Monogram v={v} /><b>${v.symbol}</b></div>
              <span className="dp-fresh-bar"><i style={{ width: `${Math.min(100, p)}%` }} /></span>
              <span className="dp-fresh-pct">{v.phase === "graduated" ? "on Uniswap" : `${p.toFixed(0)}% funded`}</span>
            </Link>
          );
        })}
      </div>
    </section>
  );
}

/** A token reaching Uniswap gets a moment: a gold banner for graduations that
 *  land while the board is open. It celebrates the token, never a user's own
 *  trading, and history already on the tape when the page loaded stays quiet. */
function GradBurst({ ventures, feed, loaded }: { ventures: Venture[] | null; feed: FeedItem[]; loaded: boolean }) {
  const seen = useRef<Set<string> | null>(null);
  const [shown, setShown] = useState<{ key: string; v: Venture } | null>(null);
  useEffect(() => {
    if (!loaded) return;
    const grads = feed.filter((i) => i.kind === "graduate");
    if (seen.current === null) { seen.current = new Set(grads.map((g) => g.key)); return; }
    const fresh = grads.find((g) => !seen.current!.has(g.key));
    grads.forEach((g) => seen.current!.add(g.key));
    const v = fresh && ventures?.find((x) => x.address.toLowerCase() === fresh.token.toLowerCase());
    if (fresh && v) setShown({ key: fresh.key, v });
  }, [feed, loaded, ventures]);
  useEffect(() => {
    if (!shown) return;
    const id = setTimeout(() => setShown(null), 7000);
    return () => clearTimeout(id);
  }, [shown]);
  if (!shown) return null;
  return (
    <Link key={shown.key} className="dp-gradburst" to={`/venture/${shown.v.address}`} viewTransition role="status">
      <span className="dp-gradburst-sparks" aria-hidden>{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ ["--i" as string]: i }} />)}</span>
      <span className="dp-gradburst-cap" aria-hidden>🎓</span>
      <span><b>${shown.v.symbol}</b> just graduated to Uniswap. Trading is live.</span>
      <span className="dp-gradburst-go">Trade it →</span>
    </Link>
  );
}

function TokenCard({ v, ethUsd, hot, record, stats }: {
  v: Venture; ethUsd: number; hot: boolean; record?: { launched: number; graduated: number }; stats?: CurveStats;
}) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  const left = v.targetRaiseWei > v.raisedWei ? v.targetRaiseWei - v.raisedWei : 0n;
  // The last stretch gets a glow: people push hardest when the goal is close.
  const close = v.phase === "raising" && funded >= 75;
  const pitch = v.meta.pitch || v.meta.description || "";
  const flash = useFlashOnChange(v.raisedWei);

  // One tag, the most useful one: what is happening to it right now.
  const tag = hot ? <span className="dp-badge dp-hot" title="Bought in the last 15 minutes">🔥 hot</span>
    : Date.now() / 1000 - v.createdAt < 86_400 && v.phase === "raising" ? <span className="dp-badge dp-new">new</span>
    : <StatusBadge v={v} />;
  const by = record && record.launched > 1
    ? `creator: ${record.launched} launches, ${record.graduated} graduated`
    : record ? "creator's first launch" : "";

  return (
    <Link className={`dp-tcard${flash ? " dp-flash" : ""}${close ? " dp-close" : ""}`} to={`/venture/${v.address}`} viewTransition>
      <div className="dp-row1">
        <Monogram v={v} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h3 title={v.name}>{v.name}</h3>
          <span className="dp-tick" title={by}>${v.symbol} · {ago(v.createdAt)}</span>
        </div>
        <div className="dp-cardmc">
          {v.phase !== "failed" && <b>{fmtMcap(v, ethUsd)}</b>}
          {tag}
        </div>
      </div>

      {pitch && <p className="dp-pitch">{pitch}</p>}

      <CurveBar v={v} />
      <div className="dp-curvelabel">
        {v.phase === "graduated" ? (
          <><span>on Uniswap</span><span>raised {fmtEth(v.raisedWei, 2)} ETH</span></>
        ) : v.phase === "failed" ? (
          <><span>missed at {funded.toFixed(0)}%</span><span>refunds open</span></>
        ) : (
          <><span><b>{funded.toFixed(0)}%</b>{close ? " · almost there" : ""}</span><span><b className="dp-togo">{fmtEth(left, 3)} ETH</b> to go</span></>
        )}
      </div>
      {stats && v.phase !== "failed" && <DueDiligence s={stats} />}
    </Link>
  );
}

/** The terminal columns, on the card: buyers, concentration, dev holdings,
 *  first-minute momentum and a sniper flag. Curve activity only. */
function DueDiligence({ s }: { s: CurveStats }) {
  const pctTxt = (n: number) => `${n < 10 ? n.toFixed(1) : n.toFixed(0)}%`;
  // Concentration means nothing with a handful of buyers; only flag it once
  // there is a crowd for the top ten to dominate.
  const concentrated = s.buyers >= 10 && s.top10Pct > 70;
  return (
    <div className="dp-dd" title="Measured on the bonding curve">
      <span title="Unique buyers">👥 {s.buyers}</span>
      {s.buyers > 0 && <span className={concentrated ? "dp-dd-warn" : ""} title="Top 10 buyers' share of the curve">top10 {pctTxt(s.top10Pct)}</span>}
      <span className={s.devPct > 10 ? "dp-dd-bad" : s.devPct > 0 ? "dp-dd-warn" : "dp-dd-ok"} title="Creator's own share of the curve">dev {pctTxt(s.devPct)}</span>
      {s.firstMinBuyers > 0 && <span className="dp-dd-ok" title="Buyers in the first 60 seconds">⚡ {s.firstMinBuyers} in 1st min</span>}
      {s.sniped && <span className="dp-dd-bad" title="Someone bought in the launch block">sniped</span>}
    </div>
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
