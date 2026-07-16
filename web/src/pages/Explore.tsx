import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { Icon } from "../components/Icon";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtNative, fmtUsd, shortAddr, timeAgo } from "../lib/format";
import { isHidden } from "../lib/hiddenTokens";

type Sort = "new" | "recent" | "mcap" | "oldest";

const SORTS: { id: Sort; label: string }[] = [
  { id: "new", label: "New" },
  { id: "recent", label: "Recent" },
  { id: "mcap", label: "Mcap" },
  { id: "oldest", label: "Oldest" },
];

/**
 * Discover — the market list, laid out like Stackr: a New button beside a
 * search field, a row of sort tabs, then a grid of token cards. Cream theme.
 */
export function Explore() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<Sort>("new");
  const [view, setView] = useState<"one" | "two">("two");
  const { data: byVolume, loading: lv } = useTokens(client, { sort: "volume", limit: 60 });
  const { data: byNew, loading: ln } = useTokens(client, { sort: "new", limit: 60 });

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 130);
    return () => window.clearTimeout(id);
  }, [query]);

  const hidden = env.hideTokens;
  const all = useMemo(() => {
    if (hidden) return [] as TokenSummary[];
    const seen = new Map<string, TokenSummary>();
    for (const t of [...(byVolume ?? []), ...(byNew ?? [])]) {
      if (!isHidden(t.address)) seen.set(t.address.toLowerCase(), t);
    }
    return [...seen.values()];
  }, [byVolume, byNew, hidden]);

  const feed = useMemo(() => {
    let list = all;
    const q = debounced;
    if (q) {
      list = all.filter(
        (t) => t.name.toLowerCase().includes(q) || t.symbol.toLowerCase().includes(q) || t.address.toLowerCase() === q,
      );
    }
    const s = [...list];
    if (sort === "mcap") s.sort((a, b) => Number(b.marketCapUsd) - Number(a.marketCapUsd));
    else if (sort === "recent") s.sort((a, b) => b.txCount24h - a.txCount24h || b.createdAt - a.createdAt);
    else if (sort === "oldest") s.sort((a, b) => a.createdAt - b.createdAt);
    else s.sort((a, b) => b.createdAt - a.createdAt);
    return s;
  }, [all, debounced, sort]);

  const loading = !hidden && (lv || ln) && all.length === 0;
  const gridCls =
    view === "one"
      ? "grid grid-cols-1 gap-2"
      : "grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-4";

  return (
    <div className="mx-auto max-w-6xl px-4 pb-20 pt-4 sm:px-5">
      {/* Search */}
      <label className="relative block">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-3">
          <Icon name="search" size={16} />
        </span>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search tokens…"
          type="search"
          className="h-9 w-full rounded-lg border border-edge bg-panel pl-9 pr-3 text-[13.5px] text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-edge-2"
        />
      </label>

      {/* Sort tabs + view toggle */}
      <div className="mt-3 flex items-center justify-between gap-2">
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-panel p-0.5">
          {SORTS.map((s) => (
            <button
              key={s.id}
              onClick={() => setSort(s.id)}
              className={`rounded-md px-3 py-1 text-[12.5px] font-medium transition-colors ${
                sort === s.id ? "bg-accent text-white" : "text-ink-2 hover:text-ink"
              }`}
            >
              {s.label}
            </button>
          ))}
        </div>
        <div className="inline-flex items-center gap-0.5 rounded-lg border border-edge bg-panel p-0.5">
          <ViewButton active={view === "one"} onClick={() => setView("one")} label="One per row">
            <path d="M4 6h16M4 12h16M4 18h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </ViewButton>
          <ViewButton active={view === "two"} onClick={() => setView("two")} label="Two per row">
            <rect x="4" y="4.5" width="7" height="7" rx="1.4" /><rect x="13" y="4.5" width="7" height="7" rx="1.4" />
            <rect x="4" y="12.5" width="7" height="7" rx="1.4" /><rect x="13" y="12.5" width="7" height="7" rx="1.4" />
          </ViewButton>
        </div>
      </div>

      {/* Grid — inside a container box */}
      <div className="mt-3 rounded-2xl border border-edge bg-panel/40 p-2.5 sm:p-3">
        {loading ? (
          <div className={gridCls}>
            {[...Array(8)].map((_, i) => <CardSkeleton key={i} />)}
          </div>
        ) : feed.length === 0 ? (
          <Empty q={debounced} />
        ) : (
          <div className={gridCls}>
            {feed.map((t) => <TokenCard key={t.address} t={t} row={view === "one"} />)}
          </div>
        )}
      </div>
    </div>
  );
}

function TokenCard({ t, row }: { t: TokenSummary; row?: boolean }) {
  const logo = t.metadata?.logo;
  const ok = logo && /^(https?:|ipfs:|data:)/.test(String(logo));
  const src = ok
    ? String(logo).startsWith("ipfs://") ? `https://ipfs.io/ipfs/${String(logo).slice(7)}` : String(logo)
    : null;
  const age = timeAgo(t.createdAt).replace(" ago", "");
  const to = `/token/${t.address}`;

  if (row) {
    const web = (t.metadata as any)?.website as string | undefined;
    const x = (t.metadata as any)?.twitter as string | undefined;
    const scan = env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/token/${t.address}` : null;
    return (
      <div className="rounded-xl border border-edge bg-panel p-3.5">
        <div className="flex gap-3">
          <Link to={to} className="shrink-0">
            <span className="grid h-12 w-12 place-items-center overflow-hidden rounded-lg border border-edge bg-panel-2 text-[12px] font-bold text-ink-3">
              {src ? (
                <img src={src} alt="" loading="lazy" className="h-full w-full object-cover"
                  onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
              ) : (
                t.symbol.slice(0, 3).toUpperCase()
              )}
            </span>
          </Link>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <Link to={to} className="truncate text-[12.5px] font-bold leading-tight text-ink">{t.name}</Link>
              <span className="mono text-[12px] font-semibold text-accent/75">${t.symbol}</span>
              <span className="rounded bg-panel-2 px-1.5 py-0.5 text-[10px] font-medium text-ink-3">{age}</span>
            </div>
            <p className="mono mt-1 truncate text-[10.5px] text-ink-3">{shortAddr(t.creator)}</p>
          </div>
        </div>

        <div className="mt-3">
          <p className="text-[9.5px] uppercase tracking-wide text-ink-3">Market cap</p>
          <p className="mono text-[13.5px] font-bold leading-tight text-accent">{fmtUsd(t.marketCapUsd)}</p>
        </div>
        <div className="mt-2.5">
          <p className="text-[9.5px] uppercase tracking-wide text-ink-3">Volume</p>
          <p className="mono text-[13.5px] font-bold leading-tight text-ink">{fmtNative(t.volumeTotalWei, 3)}</p>
        </div>

        <div className="mt-3 flex flex-wrap gap-2">
          {x ? <PillLink href={x}>X</PillLink> : null}
          {web ? <PillLink href={web}>Web</PillLink> : null}
          {scan ? <PillLink href={scan}>Scan</PillLink> : null}
          <Link to={to} className="rounded-full border border-accent/50 px-4 py-1.5 text-[10.5px] font-semibold text-accent transition-colors hover:bg-accent hover:text-white">
            Trade
          </Link>
        </div>
      </div>
    );
  }

  return (
    <Link to={`/token/${t.address}`} className="card-hover block overflow-hidden rounded-xl border border-edge bg-panel">
      {/* Full logo */}
      <div className="relative aspect-square w-full bg-panel-2">
        {src ? (
          <img src={src} alt="" loading="lazy" className="h-full w-full object-cover"
            onError={(e) => ((e.target as HTMLImageElement).style.display = "none")} />
        ) : (
          <span className="grid h-full w-full place-items-center text-[24px] font-extrabold text-ink-3">
            {t.symbol.slice(0, 3).toUpperCase()}
          </span>
        )}
        <span className="absolute right-1.5 top-1.5 rounded-md bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white backdrop-blur-sm">
          {age}
        </span>
      </div>

      <div className="p-2.5">
        <div className="flex items-baseline gap-1.5">
          <p className="min-w-0 truncate text-[12px] font-bold leading-tight text-ink">{t.name}</p>
          <span className="mono shrink-0 text-[10.5px] font-semibold text-accent/75">${t.symbol}</span>
        </div>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <span className="text-[9.5px] uppercase tracking-wide text-ink-3">Market cap</span>
          <span className="mono text-[13.5px] font-bold text-accent">{fmtUsd(t.marketCapUsd)}</span>
        </div>
        <p className="mono mt-1 truncate text-[10.5px] text-ink-3">{fmtNative(t.volumeTotalWei, 3)} vol</p>
      </div>
    </Link>
  );
}

function PillLink({ href, children }: { href: string; children: React.ReactNode }) {
  const url = /^https?:/.test(href) ? href : `https://${href}`;
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      className="rounded-full border border-edge px-4 py-1.5 text-[10.5px] font-semibold text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
    >
      {children}
    </a>
  );
}

function ViewButton({ active, onClick, label, children }: { active: boolean; onClick: () => void; label: string; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`grid h-7 w-7 place-items-center rounded-md transition-colors ${active ? "bg-accent text-white" : "text-ink-3 hover:text-ink"}`}
    >
      <svg width="16" height="16" viewBox="0 0 24 24" fill={active ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.6">
        {children}
      </svg>
    </button>
  );
}

function CardSkeleton() {
  return (
    <div className="rounded-xl border border-edge bg-panel p-2.5">
      <div className="flex items-center gap-2">
        <div className="h-8 w-8 animate-pulse rounded-full bg-panel-2" />
        <div className="flex-1 space-y-1.5">
          <div className="h-3 w-20 animate-pulse rounded bg-panel-2" />
          <div className="h-2 w-12 animate-pulse rounded bg-panel-2" />
        </div>
      </div>
      <div className="mt-2 h-8 animate-pulse rounded-md bg-panel-2" />
      <div className="mt-2 h-5 w-16 animate-pulse rounded bg-panel-2" />
    </div>
  );
}

function Empty({ q }: { q: string }) {
  return (
    <div className="flex flex-col items-center px-6 py-24 text-center">
      <span className="grid h-16 w-16 place-items-center rounded-full bg-accent/10 text-accent">
        <Icon name={q ? "search" : "launch"} size={28} />
      </span>
      <p className="mt-5 text-[19px] font-bold text-ink">
        {q ? `No token for “${q}”` : "No tokens launched yet"}
      </p>
      <p className="mt-1.5 max-w-sm text-[14.5px] leading-relaxed text-ink-2">
        {q ? "Try another name, symbol or address." : "Be the first to open a market — holders earn a real tokenized stock on every trade."}
      </p>
      {!q ? (
        <Link to="/launch" className="mt-6 flex items-center gap-2 rounded-xl bg-accent px-5 py-3 text-[14.5px] font-semibold text-white transition-colors hover:bg-accent-2">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
            <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
          Launch First Token
        </Link>
      ) : null}
    </div>
  );
}
