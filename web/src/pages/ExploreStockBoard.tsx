import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { BASE_STOCKS, baseStockOf } from "../lib/base/stocks";
import { BASE_USDC, BASE_WETH } from "../lib/base/routes";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd, timeAgo } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { isOfficial } from "../lib/official";
import { OFFICIAL_LOGOS } from "../lib/officialLogos";
import { volUsd } from "../components/market/util";
import { PREVIEW, PREVIEW_ON } from "../lib/base/preview";
import { KoiIcon } from "../components/base/KoiIcon";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

/** Shared quick-buy: sizes a whole-dollar amount into the value the coin's
 *  buy path expects and fires a real buy through the connected wallet, never
 *  leaving the page. Used by both the row bolt and the hero leader cards. */
function useQuickBuy(token: `0x${string}`, symbol: string, onDone?: () => void) {
  const { isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [busyAmt, setBusyAmt] = useState<number | null>(null);

  const buy = async (usd: number) => {
    if (busyAmt != null) return;
    if (!isConnected) { onDone?.(); return connectFirst(); }
    setBusyAmt(usd);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const value = await (client as any).quickBuyValue(token, usd);
      const hash = await (client as any).buyToken(token, value);
      pushToast({ kind: "success", title: `Buying $${usd} of ${symbol}`, txHash: hash });
      onDone?.();
    } catch (err) {
      pushToast({ kind: "error", title: "Quick buy failed", body: errorText(err) });
    } finally {
      setBusyAmt(null);
    }
  };
  return { buy, busyAmt };
}

/** The four preset buttons shown in the hero leader cards — always visible,
 *  each fires a real quick buy (matching the reference card-v-quickbuy). */
function LeaderBuy({ token, symbol }: { token: `0x${string}`; symbol: string }) {
  const { buy, busyAmt } = useQuickBuy(token, symbol);
  return (
    <div className="kf-buy-row" onClick={(e) => e.preventDefault()}>
      {[10, 25, 50, 100].map((a) => (
        <button key={a} className="kf-buy-btn" disabled={busyAmt != null}
          onClick={(e) => { e.preventDefault(); e.stopPropagation(); buy(a); }}>
          {busyAmt === a ? "…" : `$${a}`}
        </button>
      ))}
    </div>
  );
}

/** The row's lightning bolt reveals a full-width strip of the $10/$25/$50/$100
 *  presets on a second line, each firing a real buy — mirroring the reference
 *  row quick-buy. */
function QuickBuyBolt({ token, symbol }: { token: `0x${string}`; symbol: string }) {
  const [open, setOpen] = useState(false);
  const { buy, busyAmt } = useQuickBuy(token, symbol, () => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      const el = e.target as HTMLElement;
      if (!el.closest?.(`[data-qb="${token}"]`)) setOpen(false);
    };
    document.addEventListener("pointerdown", away);
    return () => document.removeEventListener("pointerdown", away);
  }, [open, token]);

  return (
    <>
      <button
        className={`kf-bolt ${open ? "on" : ""}`}
        data-qb={token}
        aria-label={`Quick buy ${symbol}`}
        aria-expanded={open}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); setOpen((o) => !o); }}
      >
        {BOLT}
      </button>
      {open ? (
        <span className="kf-qb-strip" data-qb={token} role="group" onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
          {[10, 25, 50, 100].map((a) => (
            <button key={a} className="kf-qb-amt" disabled={busyAmt != null} onClick={() => buy(a)}>
              {busyAmt === a ? "…" : `$${a}`}
            </button>
          ))}
        </span>
      ) : null}
    </>
  );
}

type Tab = "top" | "trending" | "movers" | "new" | "live";
const TABS: { id: Tab; label: string; live?: boolean }[] = [
  { id: "top", label: "Top" },
  { id: "trending", label: "Trending" },
  { id: "movers", label: "Movers" },
  { id: "live", label: "Live", live: true },
];

/* ---- reward (the stock/asset each coin pays holders) ---- */
const rewardLabel = (addr?: string) => {
  if (!addr) return null;
  if (addr.toLowerCase() === BASE_WETH.toLowerCase()) return "ETH";
  if (addr.toLowerCase() === BASE_USDC.toLowerCase()) return "USDC";
  return baseStockOf(addr)?.symbol ?? null;
};
const rewardOf = (t: TokenSummary) => rewardLabel((t.metadata as any)?.rewardStock as string | undefined);

/* ---- circular avatar: token logo, else the branded default tile ---- */
// Default token logo, shown for any coin without its own image (matches the
// reference, which serves a single branded placeholder rather than initials).
const DEFAULT_LOGO = "/stonked-default.svg";
function logoSrc(t: TokenSummary): string | null {
  const logo = OFFICIAL_LOGOS[t.address?.toLowerCase()] ?? t.metadata?.logo;
  if (!logo || !/^(https?:|ipfs:|data:)/.test(String(logo))) return null;
  return String(logo).startsWith("ipfs://") ? `https://ipfs.io/ipfs/${String(logo).slice(7)}` : String(logo);
}
function Avatar({ t }: { t: TokenSummary }) {
  const [failed, setFailed] = useState(false);
  const src = (failed ? null : logoSrc(t)) ?? DEFAULT_LOGO;
  return (
    <span className="kf-ava-wrap">
      <span className="kf-ava">
        <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />
      </span>
      <span className="kf-badge">{BASE_MARK}</span>
    </span>
  );
}

// The Base network brandmark — a blue disc flattened on the right — marks every
// coin as launched on Base, replacing the old lime quill.
const BASE_MARK = (
  <svg viewBox="0 0 40 40" aria-hidden>
    <circle cx="20" cy="20" r="20" fill="#fff" />
    <path d="M24 2.45 A18 18 0 1 0 24 37.55 Z" fill="#0052FF" />
  </svg>
);
const FIRE =<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="kf-fire"><path d="M12 2.5C8.7 6.7 6.2 9.7 6.2 13.4a5.8 5.8 0 0 0 11.6 0c0-3.7-2.5-6.7-5.8-10.9Zm0 16.3a3 3 0 0 1-3-3c0-1.4 1.1-2.8 3-4.2 1.9 1.4 3 2.8 3 4.2a3 3 0 0 1-3 3Z" /></svg>;
const CUP = <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className="kf-cup"><path d="M7 3h10v2h3.5v2.2A3.8 3.8 0 0 1 16.7 11h-.3a5 5 0 0 1-3.4 2.9V16h3v2.5H8V16h3v-2.1A5 5 0 0 1 7.6 11h-.3a3.8 3.8 0 0 1-3.8-3.8V5H7V3Zm-1.5 4.2c0 1 .8 1.8 1.8 1.8h-.1A6.9 6.9 0 0 1 7 5.5H5.5v1.7ZM18.5 7.2V5.5H17c.1 1.2 0 2.4-.2 3.5h-.1c1 0 1.8-.8 1.8-1.8Z" /></svg>;
const UP_TRI = <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 6l7 12H5z" /></svg>;
const DN_TRI = <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden><path d="M12 18 5 6h14z" /></svg>;
const BOLT = <KoiIcon name="zap" size={18} />;

function ordinal(n: number) {
  return ["th", "st", "nd", "rd"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10];
}

/**
 * koi.fun discovery dashboard — an electric-blue "Today's leaders" board over
 * a live pool list, wired to real launches. The product's hook (each coin pays
 * holders a real tokenized stock) rides along as the reward tag on every row.
 */
export function ExploreStockBoard() {
  const [sp, setSp] = useSearchParams();
  const tab = (sp.get("tab") as Tab) || "movers";
  const [filter, setFilter] = useState<string | null>(null);
  const [dropOpen, setDropOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const showSearch = sp.get("focus") === "1" || debounced.length > 0;

  const { data: byVolume, loading: lv } = useTokens(client, { sort: "volume", limit: 100 });
  const { data: byNew, loading: ln } = useTokens(client, { sort: "new", limit: 100 });

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 130);
    return () => window.clearTimeout(id);
  }, [query]);
  useEffect(() => { if (sp.get("focus") === "1") searchRef.current?.focus(); }, [sp]);
  useEffect(() => {
    if (!dropOpen) return;
    const close = () => setDropOpen(false);
    document.addEventListener("click", close);
    return () => document.removeEventListener("click", close);
  }, [dropOpen]);

  const setTab = (id: Tab) => {
    const n = new URLSearchParams(sp);
    n.delete("focus");
    if (id === "movers") n.delete("tab"); else n.set("tab", id);
    setSp(n, { replace: true });
  };

  const all = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    const seen = new Map<string, TokenSummary>();
    for (const t of [...(byVolume ?? []), ...(byNew ?? [])]) {
      if (!isHidden(t.address) && !isImpersonator(t)) seen.set(t.address.toLowerCase(), t);
    }
    const list = [...seen.values()];
    if (list.length === 0 && PREVIEW_ON) return PREVIEW;
    return list;
  }, [byVolume, byNew]);

  const leaders = useMemo(() => {
    const priced = all.filter((t) => Number(t.marketCapUsd) > 0);
    const pool = priced.length > 0 ? priced : all;
    const withChg = pool.filter((t) => { const c = t.priceChange24hPct; return c != null && isFinite(c) && c > 0; });
    const base = (withChg.length >= 3 ? withChg : pool).slice();
    base.sort((a, b) => (b.priceChange24hPct ?? 0) - (a.priceChange24hPct ?? 0) || volUsd(b) - volUsd(a));
    return base.slice(0, 3);
  }, [all]);

  const feed = useMemo(() => {
    let list = all;
    if (filter) list = list.filter((t) => rewardOf(t) === filter);
    if (debounced) list = list.filter((t) => t.name.toLowerCase().includes(debounced) || t.symbol.toLowerCase().includes(debounced) || t.address.toLowerCase() === debounced);
    const s = [...list];
    if (tab === "top") s.sort((a, b) => Number(b.marketCapUsd) - Number(a.marketCapUsd));
    else if (tab === "trending") s.sort((a, b) => volUsd(b) - volUsd(a));
    else if (tab === "new") s.sort((a, b) => b.createdAt - a.createdAt);
    else if (tab === "live") { s.sort((a, b) => (b.txCount24h ?? 0) - (a.txCount24h ?? 0) || b.createdAt - a.createdAt); }
    else s.sort((a, b) => (b.priceChange24hPct ?? -999) - (a.priceChange24hPct ?? -999) || volUsd(b) - volUsd(a));
    return s;
  }, [all, filter, debounced, tab]);

  const stats = useMemo(() => ({
    count: all.length,
    mcap: all.reduce((a, t) => a + Number(t.marketCapUsd || 0), 0),
    vol: all.reduce((a, t) => a + volUsd(t), 0),
  }), [all]);

  const rewards = useMemo(() => {
    const set = new Set<string>();
    all.forEach((t) => { const r = rewardOf(t); if (r) set.add(r); });
    return ["ETH", "USDC", ...BASE_STOCKS.map((s) => s.symbol)].filter((r) => set.has(r));
  }, [all]);

  const loading = !env.hideTokens && (lv || ln) && all.length === 0;

  return (
    <div className="kf kf-page">
      {/* Hero: headline + copy + today's leaders, all inside the blue card */}
      <section className="kf-hero" aria-label="Today's leaders">
        {/* Animated water surface — koi-pond shimmer + flowing waves */}
        <div className="kf-hero-water" aria-hidden>
          <span className="kf-wave kf-wave-1" />
          <span className="kf-wave kf-wave-2" />
          <span className="kf-wave kf-wave-3" />
        </div>
        <div className="kf-hero-grid">
          <div>
            <svg className="kf-hero-mascot" viewBox="0 0 40 40" fill="none" aria-hidden>
              {/* derpy meme man in a Base hoodie */}
              <rect x="1.5" y="1.5" width="37" height="37" rx="11" fill="#0f1113" />
              <g transform="scale(0.3333)">
                <path d="M4 120 V102 C4 88 22 80 60 80 C98 80 116 88 116 102 V120 Z" fill="#0052FF" />
                <path d="M60 82 L52 120 H68 Z" fill="#0040cc" />
                <g transform="translate(60 104)"><circle r="8" fill="#fff" /><path d="M4 -8 A8 8 0 1 0 4 8 Z" fill="#0052FF" /></g>
                <path d="M16 54 C16 20 34 6 60 6 C86 6 104 20 104 54 C104 74 92 86 74 90 L46 90 C28 86 16 74 16 54 Z" fill="#0052FF" />
                <rect x="47" y="84" width="3" height="26" rx="1.5" fill="#eef1f5" />
                <rect x="70" y="84" width="3" height="22" rx="1.5" fill="#eef1f5" />
                <circle cx="48.5" cy="112" r="2.6" fill="#eef1f5" /><circle cx="71.5" cy="108" r="2.6" fill="#eef1f5" />
                <ellipse cx="30" cy="50" rx="5" ry="7.5" fill="#c9cdd2" /><ellipse cx="90" cy="50" rx="5" ry="7.5" fill="#c9cdd2" />
                <path d="M60 18 C40 18 31 32 31 50 C31 70 44 82 60 82 C76 82 89 70 89 50 C89 32 80 18 60 18 Z" fill="#c9cdd2" />
                <circle cx="50" cy="48" r="6" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="53" cy="50" r="2.4" fill="#20242b" />
                <circle cx="72" cy="46" r="5" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="69" cy="48" r="2" fill="#20242b" />
                <path d="M58 56 C56 62 55 65 53 67 C56 69 61 69 63 67" stroke="#20242b" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
                <path d="M50 72 Q57 78 64 72" stroke="#20242b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
              </g>
            </svg>
            <h1 className="kf-hero-title-xl">Hold &amp; Earn</h1>
            <p className="kf-hero-copy">Every coin pairs a real tokenized stock. Each trade streams that stock to holders, paid out every day.</p>
          </div>
          <div>
            <h2 className="kf-hero-label">Today's leaders</h2>
            <div className="kf-lb-scroll">
          {loading || leaders.length === 0 ? (
            [...Array(3)].map((_, i) => <div key={i} className="kf-lb-card" style={{ height: 168 }} />)
          ) : (
            leaders.map((t, i) => {
              const chg = t.priceChange24hPct;
              const has = chg != null && isFinite(chg);
              return (
                <Link to={`/token/${t.address}`} key={t.address} className="kf-lb-card">
                  <div className="kf-lb-top">
                    <span className="kf-rank">{i + 1}<sup>{ordinal(i + 1)}</sup></span>
                    <span className="kf-ava" style={{ width: 34, height: 34 }}>
                      <img src={logoSrc(t) ?? DEFAULT_LOGO} alt="" />
                    </span>
                    <span className="kf-lb-name">${t.symbol}</span>
                  </div>
                  <div className="kf-lb-stats">
                    <div className="kf-stat"><div className="k">Market Cap</div><div className="v">{Number(t.marketCapUsd) > 0 ? fmtUsd(t.marketCapUsd) : "—"}</div></div>
                    <div className="kf-stat"><div className="k">Volume</div><div className="v">{volUsd(t) > 0 ? fmtUsd(volUsd(t)) : "—"}</div></div>
                    <div className="kf-stat chg"><div className="k">24h</div><div className={`v ${has ? (chg! >= 0 ? "up" : "down") : ""}`}>{has ? `${chg! >= 0 ? "+" : ""}${chg!.toFixed(2)}%` : "—"}</div></div>
                  </div>
                  <LeaderBuy token={t.address as `0x${string}`} symbol={t.symbol} />
                </Link>
              );
            })
          )}
            </div>
          </div>
        </div>
      </section>

      {/* Section head + reward filter */}
      <div className="kf-sec-head">
        <h1 className="kf-sec-title">Pools</h1>
        <div className={`kf-drop ${dropOpen ? "open" : ""}`}>
          <button className="kf-drop-btn" aria-haspopup="true" aria-expanded={dropOpen} onClick={(e) => { e.stopPropagation(); setDropOpen((o) => !o); }}>
            {filter ?? "All"}
            <KoiIcon name="chevron-down" size={15} />
          </button>
          {dropOpen && (
            <div className="kf-drop-menu" role="menu" onClick={(e) => e.stopPropagation()}>
              <button className={filter === null ? "on" : ""} onClick={() => { setFilter(null); setDropOpen(false); }}>All</button>
              {rewards.map((r) => (
                <button key={r} className={filter === r ? "on" : ""} onClick={() => { setFilter(r); setDropOpen(false); }}>{r}</button>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Tabs */}
      <nav className="kf-tabs" aria-label="Pool views">
        {TABS.map((t) => (
          <button key={t.id} className={`kf-tab ${tab === t.id ? "on" : ""}`} onClick={() => setTab(t.id)}>
            {t.live ? <span className="kf-live-dot" /> : null}{t.label}
          </button>
        ))}
      </nav>

      {/* Search (revealed by the nav search action) */}
      {showSearch && (
        <div style={{ padding: "0 16px 8px" }}>
          <label className="relative block">
            <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            </span>
            <input ref={searchRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search coins…" type="search"
              className="h-11 w-full rounded-2xl border border-edge bg-panel pl-9 pr-3 text-[14px] text-ink outline-none placeholder:text-ink-3 focus:border-edge-2" />
          </label>
        </div>
      )}

      {/* Pool list */}
      <div className="kf-pools">
        {loading ? (
          [...Array(8)].map((_, i) => <div key={i} className="kf-skel" />)
        ) : feed.length === 0 ? (
          <div className="kf-empty">
            {filter ? `No coin earns ${filter} yet. ` : debounced ? "No match. " : "No coins launched yet. "}
            <Link to="/launch">Launch the first one</Link>.
          </div>
        ) : (
          feed.map((t) => {
            const chg = t.priceChange24hPct;
            const has = chg != null && isFinite(chg);
            const hot = has && chg! >= 20;
            const official = isOfficial(t.address);
            const fresh = !!t.createdAt && Date.now() / 1000 - t.createdAt < 86400;
            const tint = has ? (chg! >= 0 ? "tint-up" : "tint-dn") : "";
            return (
              <Link to={`/token/${t.address}`} key={t.address} className={`kf-pool ${tint}`}>
                <Avatar t={t} />
                <span className="kf-pool-mid">
                  <span className="kf-pool-name-row">
                    <span className="kf-pool-name">{t.name}</span>
                    {(hot || official) && <span className="kf-flags">{hot && FIRE}{official && CUP}</span>}
                    {fresh && <span className="kf-new-badge">New</span>}
                  </span>
                  <span className="kf-pool-sub">
                    <span className="kf-tk">{t.symbol}</span>
                    {volUsd(t) > 0 ? <span className="kf-vol">· {fmtUsd(volUsd(t))} vol</span> : null}
                  </span>
                </span>
                <span className="kf-pool-right">
                  <span className="kf-pool-mc">{Number(t.marketCapUsd) > 0 ? fmtUsd(t.marketCapUsd) : "—"}</span>
                  <span className={`kf-pool-chg ${has ? (chg! >= 0 ? "up" : "down") : "flat"}`}>
                    {has ? (chg! >= 0 ? UP_TRI : DN_TRI) : null}{has ? `${chg! >= 0 ? "+" : ""}${chg!.toFixed(2)}%` : "0.00%"}
                  </span>
                </span>
                <QuickBuyBolt token={t.address as `0x${string}`} symbol={t.symbol} />
              </Link>
            );
          })
        )}
      </div>
    </div>
  );
}
