import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { TokenLogo } from "../components/TokenLogo";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { volUsd } from "../components/market/util";
import { PREVIEW, PREVIEW_ON } from "../lib/base/preview";

const ord = (n: number) => ["th", "st", "nd", "rd"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10];

/**
 * Rewards — the realtime holder-reward page: blue hero explaining the
 * reward cycle, today's leading coins, and the full ranking below.
 */
export function BaseParty() {
  const { data: byVolume } = useTokens(client, { sort: "volume", limit: 100 });

  const all = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    const l = (byVolume ?? []).filter((t) => !isHidden(t.address) && !isImpersonator(t));
    return l.length === 0 && PREVIEW_ON ? PREVIEW : l;
  }, [byVolume]);

  const ranked = useMemo(() => {
    const s = [...all];
    s.sort((a, b) => volUsd(b) - volUsd(a) || Number(b.marketCapUsd) - Number(a.marketCapUsd));
    return s;
  }, [all]);
  const winners = ranked.slice(0, 3);

  return (
    <div className="kf kf-page">
      <section className="kf-hero">
        <h1 className="kf-hero-title-xl">Rewards</h1>
        <p className="kf-hero-copy">
          Every koi.fun trade streams the paired asset to holders in real time — no snapshots, no waiting. The more a coin trades, the more its holders earn.
        </p>
      </section>

      <div className="kf-sec-head" style={{ paddingBottom: 4 }}>
        <h2 className="kf-sec-title" style={{ fontSize: 22 }}>Top reward pools</h2>
      </div>
      <p className="kf-sec-sub">The coins streaming the most to holders right now, ranked by 24h volume.</p>

      <div className="kf-win-scroll">
        {winners.length === 0
          ? [...Array(2)].map((_, i) => <div key={i} className="kf-win-card" style={{ height: 130 }} />)
          : winners.map((t, i) => {
              const chg = t.priceChange24hPct;
              const has = chg != null && isFinite(chg);
              return (
                <Link to={`/token/${t.address}`} key={t.address} className="kf-win-card">
                  <div className="kf-win-top">
                    <TokenLogo token={t} size={40} />
                    <span className="kf-win-name">${t.symbol}</span>
                    <span className="kf-win-rank">{i + 1}<sub>{ord(i + 1)}</sub></span>
                  </div>
                  <div className={`kf-win-chg ${has ? (chg! >= 0 ? "up" : "dn") : ""}`}>
                    {has ? `${chg! >= 0 ? "+" : ""}${chg!.toFixed(2)}%` : "new"}
                  </div>
                  <span className="kf-win-go" aria-hidden>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M9 7h8v8" /></svg>
                  </span>
                </Link>
              );
            })}
      </div>

      <div className="kf-sec-head" style={{ paddingBottom: 6 }}>
        <h2 className="kf-sec-title" style={{ fontSize: 22 }}>All coins</h2>
      </div>
      <div className="kf-rank-list">
        {ranked.slice(0, 25).map((t, i) => {
          const chg = t.priceChange24hPct;
          const has = chg != null && isFinite(chg);
          return (
            <Link to={`/token/${t.address}`} key={t.address} className="kf-rank-row">
              <span className="kf-rank-num">{i + 1}</span>
              <TokenLogo token={t} size={36} />
              <span className="kf-rank-name"><b>{t.name}</b><i>{t.symbol}</i></span>
              <span className="kf-rank-val">
                {volUsd(t) > 0 ? fmtUsd(volUsd(t)) : "—"}
                <i className={has ? (chg! >= 0 ? "up" : "dn") : ""}>{has ? `${chg! >= 0 ? "+" : ""}${chg!.toFixed(2)}%` : "—"}</i>
              </span>
            </Link>
          );
        })}
        {ranked.length === 0 && <div className="kf-empty">No coins ranked yet today.</div>}
      </div>
    </div>
  );
}
