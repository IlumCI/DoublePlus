import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { FavoriteButton } from "../components/market/FavoriteButton";
import { FilterButton, FilterDrawer } from "../components/market/FilterDrawer";
import { MarketTabs, type MarketSort } from "../components/market/MarketTabs";
import { Pagination } from "../components/market/Pagination";
import { SearchBar } from "../components/market/SearchBar";
import { TokenCard } from "../components/market/TokenCard";
import { TokenTable } from "../components/market/TokenTable";
import { ViewToggle, type MarketView } from "../components/market/ViewToggle";
import { useFavorites } from "../components/market/useFavorites";
import {
  EMPTY_FILTERS,
  activeFilterCount,
  liqUsd,
  volUsd,
  type MarketFilters,
} from "../components/market/util";
import { TokenLogo } from "../components/TokenLogo";
import { IS_STOCK_BOARD } from "../lib/brand";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd, timeAgo } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { isOfficial } from "../lib/official";

const PAGE_SIZE = 20;

/** Neo-brutalist market terminal: bold editorial header, functional sort
 *  tabs, search, filters, favorites, list/grid views, and pagination. */
export function ExploreBoard() {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [sort, setSort] = useState<MarketSort>("mcap");
  const [view, setView] = useState<MarketView>("list");
  const [filters, setFilters] = useState<MarketFilters>(EMPTY_FILTERS);
  const [drawer, setDrawer] = useState(false);
  const [page, setPage] = useState(1);
  const { favs, isFav, toggle } = useFavorites();
  const { data: byVolume, loading: lv } = useTokens(client, { sort: "volume", limit: 100 });
  const { data: byNew, loading: ln } = useTokens(client, { sort: "new", limit: 100 });

  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim().toLowerCase()), 130);
    return () => window.clearTimeout(id);
  }, [query]);

  useEffect(() => setPage(1), [debounced, sort, filters]);

  const all = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    const seen = new Map<string, TokenSummary>();
    for (const t of [...(byVolume ?? []), ...(byNew ?? [])]) {
      if (!isHidden(t.address) && !isImpersonator(t)) seen.set(t.address.toLowerCase(), t);
    }
    return [...seen.values()];
  }, [byVolume, byNew]);

  const feed = useMemo(() => {
    let list = all;
    if (debounced) {
      list = list.filter(
        (t) =>
          t.name.toLowerCase().includes(debounced) ||
          t.symbol.toLowerCase().includes(debounced) ||
          t.address.toLowerCase() === debounced,
      );
    }
    if (filters.favOnly) list = list.filter((t) => favs.has(t.address.toLowerCase()));
    if (filters.officialOnly) list = list.filter((t) => isOfficial(t.address));
    if (filters.hideZeroVol) list = list.filter((t) => volUsd(t) > 0);
    if (filters.minLiqUsd > 0) list = list.filter((t) => liqUsd(t) >= filters.minLiqUsd);
    if (filters.minVolUsd > 0) list = list.filter((t) => volUsd(t) >= filters.minVolUsd);

    const s = [...list];
    if (sort === "mcap") s.sort((a, b) => Number(b.marketCapUsd) - Number(a.marketCapUsd));
    else if (sort === "vol") s.sort((a, b) => volUsd(b) - volUsd(a));
    else if (sort === "recent") s.sort((a, b) => b.txCount24h - a.txCount24h);
    else if (sort === "new") s.sort((a, b) => b.createdAt - a.createdAt);
    else s.sort((a, b) => a.createdAt - b.createdAt);
    return s;
  }, [all, debounced, sort, filters, favs]);

  const pages = Math.max(1, Math.ceil(feed.length / PAGE_SIZE));
  const shown = feed.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const loading = !env.hideTokens && (lv || ln) && all.length === 0;
  const nFilters = activeFilterCount(filters);

  return (
    <div className="cpm">
      <section className="cpm-hero">
        <h1 className="cpm-headline">Explore Markets</h1>
        <div className="nb-divider" aria-hidden />
      </section>

      <section className="cpm-list" aria-label="Token markets">
        <MarketTabs sort={sort} onSort={setSort} />

        <div className="cpm-toolbar">
          <SearchBar value={query} onChange={setQuery} />
          <FilterButton count={nFilters} onClick={() => setDrawer(true)} />
          <ViewToggle view={view} onView={setView} />
          <button
            type="button"
            onClick={() => setFilters((f) => ({ ...f, favOnly: !f.favOnly }))}
            className={`nb-btn nb-icon ${filters.favOnly ? "on" : ""}`}
            aria-label="Show favorites only"
            aria-pressed={filters.favOnly}
            title="Favorites"
          >
            <svg width="17" height="17" viewBox="0 0 24 24" fill={filters.favOnly ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.4" aria-hidden>
              <path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.6l6.5-.9z" />
            </svg>
          </button>
        </div>

        {loading ? (
          <div className="cpm-grid">
            {[...Array(6)].map((_, i) => (
              <div key={i} className="cpm-skel" />
            ))}
          </div>
        ) : shown.length === 0 ? (
          <div className="cpm-empty">
            {debounced || nFilters > 0 ? (
              <>No market matches. Loosen the search or filters.</>
            ) : (
              <>
                The board is clean.{" "}
                <Link to="/launch" className="cpm-link">
                  {IS_STOCK_BOARD ? "Launch the first coin" : "Pull the first job"}
                </Link>
              </>
            )}
          </div>
        ) : view === "grid" ? (
          <div className="nb-grid">
            {shown.map((t) => (
              <TokenCard key={t.address} t={t} fav={isFav(t.address)} onFav={() => toggle(t.address)} />
            ))}
          </div>
        ) : (
          <>
            {/* Desktop: full data table. Mobile: compact bordered rows. */}
            <div className="hidden md:block">
              <TokenTable tokens={shown} isFav={isFav} onFav={toggle} />
            </div>
            <div className="cpm-grid md:hidden">
              {shown.map((t) => (
                <MobileRow key={t.address} t={t} fav={isFav(t.address)} onFav={() => toggle(t.address)} />
              ))}
            </div>
          </>
        )}

        <Pagination page={page} pages={pages} onPage={setPage} />
      </section>

      <FilterDrawer open={drawer} filters={filters} onChange={setFilters} onClose={() => setDrawer(false)} />
    </div>
  );
}

/** Compact list row for small screens; same data, stacked layout. */
function MobileRow({ t, fav, onFav }: { t: TokenSummary; fav: boolean; onFav: () => void }) {
  const chg = t.priceChange24hPct;
  const hasChg = chg != null && isFinite(chg) && chg !== 0;
  return (
    <Link to={`/token/${t.address}`} className="cpt">
      <span className="lg">
        <TokenLogo token={t} size={36} />
      </span>
      <span className="id">
        <b>{t.name}</b>
        <span className="sym">
          ${t.symbol}
          {isOfficial(t.address) && <em className="off">OFFICIAL</em>}
        </span>
      </span>
      <span className="col vol">
        <i>24h vol</i>
        <span>{fmtUsd(volUsd(t))}</span>
      </span>
      <span className="col age">
        <i>Age</i>
        <span>{timeAgo(t.createdAt).replace(" ago", "")}</span>
      </span>
      <span className={`chg ${hasChg ? (chg! >= 0 ? "up" : "dn") : "none"}`}>
        {hasChg ? `${chg! >= 0 ? "+" : ""}${Math.abs(chg!) >= 100 ? Math.round(chg!) : chg!.toFixed(1)}%` : "–"}
      </span>
      <span className="col mcap">
        <i>Mcap</i>
        <span className="mc">{fmtUsd(t.marketCapUsd)}</span>
      </span>
      <span onClick={(e) => e.preventDefault()}>
        <FavoriteButton on={fav} onToggle={onFav} size={15} />
      </span>
    </Link>
  );
}
