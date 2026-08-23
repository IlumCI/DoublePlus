import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { TokenLogo } from "../components/TokenLogo";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { volUsd } from "../components/market/util";
import { PREVIEW, PREVIEW_ON } from "../lib/base/preview";

/**
 * Search — a trending list with the search field docked at the bottom of the
 * screen (thumb reach), closing back to the board.
 */
export function BaseSearch() {
  const nav = useNavigate();
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const { data: byVolume } = useTokens(client, { sort: "volume", limit: 100 });
  const { data: byNew } = useTokens(client, { sort: "new", limit: 100 });

  useEffect(() => { inputRef.current?.focus(); }, []);
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(q.trim().toLowerCase()), 120);
    return () => window.clearTimeout(id);
  }, [q]);

  const all = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    const seen = new Map<string, TokenSummary>();
    for (const t of [...(byVolume ?? []), ...(byNew ?? [])]) {
      if (!isHidden(t.address) && !isImpersonator(t)) seen.set(t.address.toLowerCase(), t);
    }
    const l = [...seen.values()];
    return l.length === 0 && PREVIEW_ON ? PREVIEW : l;
  }, [byVolume, byNew]);

  const list = useMemo(() => {
    let l = all;
    if (debounced) l = l.filter((t) => t.name.toLowerCase().includes(debounced) || t.symbol.toLowerCase().includes(debounced) || t.address.toLowerCase() === debounced);
    return [...l].sort((a, b) => volUsd(b) - volUsd(a)).slice(0, 20);
  }, [all, debounced]);

  return (
    <div className="kf kf-page" style={{ paddingBottom: 120 }}>
      <h1 className="kf-page-h1">{debounced ? "Results" : "Trending"}</h1>
      <div>
        {list.map((t) => {
          const chg = t.priceChange24hPct;
          const has = chg != null && isFinite(chg);
          return (
            <Link to={`/token/${t.address}`} key={t.address} className="kf-srow">
              <TokenLogo token={t} size={46} />
              <span className="kf-srow-mid"><b>{t.name}</b><i>{t.symbol}</i></span>
              <span className="kf-srow-right">
                <b>{Number(t.marketCapUsd) > 0 ? fmtUsd(t.marketCapUsd) : "—"}</b>
                <i className={has ? (chg! >= 0 ? "up" : "dn") : ""}>{has ? `${chg! >= 0 ? "+" : ""}${chg!.toFixed(2)}%` : "new"}</i>
              </span>
            </Link>
          );
        })}
        {list.length === 0 && <div className="kf-empty">{debounced ? "No match." : "Nothing trending yet."}</div>}
      </div>

      <div className="kf-search-dock">
        <label className="kf-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input ref={inputRef} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search basedstonk tokens" />
        </label>
        <button className="kf-search-x" aria-label="Close search" onClick={() => nav("/")}>
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round"><path d="M5 5l14 14M19 5 5 19" /></svg>
        </button>
      </div>
    </div>
  );
}
