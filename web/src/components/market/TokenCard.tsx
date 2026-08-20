import { Link } from "react-router-dom";
import type { TokenSummary } from "@launchpad/sdk";

import { FavoriteButton } from "./FavoriteButton";
import { fmtPrice, liqUsd, volUsd } from "./util";
import { TokenLogo } from "../TokenLogo";
import { fmtUsd, timeAgo } from "../../lib/format";
import { isOfficial } from "../../lib/official";

export function TokenCard({
  t,
  fav,
  onFav,
}: {
  t: TokenSummary;
  fav: boolean;
  onFav: () => void;
}) {
  const chg = t.priceChange24hPct;
  const hasChg = chg != null && isFinite(chg) && chg !== 0;
  return (
    <Link to={`/token/${t.address}`} className="nb-card">
      <div className="hd">
        <span className="nb-tok">
          <span className="lg">
            <TokenLogo token={t} size={34} />
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{t.name}</b>
            <span className="sym mono">
              ${t.symbol}
              {isOfficial(t.address) && <em className="nb-off">OFFICIAL</em>}
            </span>
          </span>
        </span>
        <FavoriteButton on={fav} onToggle={onFav} />
      </div>
      <div className="kpi">
        <span className="mc">{fmtUsd(t.marketCapUsd)}</span>
        <span className={`mono nb-chg ${hasChg ? (chg! >= 0 ? "up" : "dn") : "z"}`} style={{ fontSize: 13 }}>
          {hasChg ? `${chg! >= 0 ? "+" : ""}${Math.abs(chg!) >= 100 ? Math.round(chg!) : chg!.toFixed(1)}%` : "0.0%"}
        </span>
      </div>
      <div className="ft">
        <span>{fmtPrice(Number(t.priceUsd))}</span>
        <span>VOL {fmtUsd(volUsd(t))}</span>
        <span>LIQ {fmtUsd(liqUsd(t))}</span>
        <span>{timeAgo(t.createdAt).replace(" ago", "")}</span>
      </div>
    </Link>
  );
}
