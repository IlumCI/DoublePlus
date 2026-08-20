import { useNavigate } from "react-router-dom";
import type { TokenSummary } from "@launchpad/sdk";

import { FavoriteButton } from "./FavoriteButton";
import { fmtPrice, liqUsd, volUsd } from "./util";
import { TokenLogo } from "../TokenLogo";
import { fmtUsd, timeAgo } from "../../lib/format";
import { isOfficial } from "../../lib/official";

function TokenRow({
  t,
  fav,
  onFav,
}: {
  t: TokenSummary;
  fav: boolean;
  onFav: () => void;
}) {
  const navigate = useNavigate();
  const chg = t.priceChange24hPct;
  const hasChg = chg != null && isFinite(chg) && chg !== 0;
  return (
    <tr
      className="nb-row"
      onClick={() => navigate(`/token/${t.address}`)}
      onKeyDown={(e) => e.key === "Enter" && navigate(`/token/${t.address}`)}
      tabIndex={0}
      aria-label={`${t.name} market`}
    >
      <td className="l" onClick={(e) => e.stopPropagation()}>
        <FavoriteButton on={fav} onToggle={onFav} />
      </td>
      <td className="l">
        <span className="nb-tok">
          <span className="lg">
            <TokenLogo token={t} size={34} />
          </span>
          <span style={{ minWidth: 0 }}>
            <b>{t.name}</b>
            <span className="sym">
              ${t.symbol}
              {isOfficial(t.address) && <em className="nb-off">OFFICIAL</em>}
            </span>
          </span>
        </span>
      </td>
      <td>{fmtPrice(Number(t.priceUsd))}</td>
      <td style={{ fontWeight: 800, color: "var(--color-ink)" }}>{fmtUsd(t.marketCapUsd)}</td>
      <td>{fmtUsd(volUsd(t))}</td>
      <td>{fmtUsd(liqUsd(t))}</td>
      <td>{timeAgo(t.createdAt).replace(" ago", "")}</td>
      <td className={`nb-chg ${hasChg ? (chg! >= 0 ? "up" : "dn") : "z"}`}>
        {hasChg ? `${chg! >= 0 ? "+" : ""}${Math.abs(chg!) >= 100 ? Math.round(chg!) : chg!.toFixed(1)}%` : "0.0%"}
      </td>
    </tr>
  );
}

export function TokenTable({
  tokens,
  isFav,
  onFav,
}: {
  tokens: TokenSummary[];
  isFav: (a: string) => boolean;
  onFav: (a: string) => void;
}) {
  return (
    <div className="nb-board" style={{ overflowX: "auto" }}>
      <table className="nb-table">
        <thead>
          <tr>
            <th aria-label="Favorite" />
            <th className="l">Token</th>
            <th>Price</th>
            <th>Mcap</th>
            <th>Volume</th>
            <th>Liquidity</th>
            <th>Age</th>
            <th>Change</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <TokenRow key={t.address} t={t} fav={isFav(t.address)} onFav={() => onFav(t.address)} />
          ))}
        </tbody>
      </table>
    </div>
  );
}
