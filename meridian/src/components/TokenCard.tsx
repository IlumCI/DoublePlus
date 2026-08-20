import { useNavigate } from "react-router-dom";
import { chainById, type LaunchToken } from "../lib/data";
import { fmtPct, fmtUsd, shortAddr, timeAgo } from "../lib/format";
import { useApp } from "../lib/store";
import { Icon } from "./Icon";
import { TokenIcon } from "./TokenIcon";

export function StatusBadgeToken({ token }: { token: LaunchToken }) {
  if (token.status === "graduated") return <span className="badge warn">Graduated</span>;
  if (token.status === "new")
    return (
      <span className="badge accent">
        <span className="live-dot" />
        New
      </span>
    );
  return (
    <span className="badge accent">
      <span className="live-dot" />
      Live
    </span>
  );
}

export function TokenCard({
  token,
  onQuickBuy,
}: {
  token: LaunchToken;
  onQuickBuy: (t: LaunchToken) => void;
}) {
  const navigate = useNavigate();
  const { favorites, toggleFavorite } = useApp();
  const chain = chainById(token.chain);
  const fav = favorites.includes(token.ticker);

  return (
    <article
      className="card hover"
      style={{ cursor: "pointer", display: "flex", flexDirection: "column", gap: 14 }}
      onClick={() => navigate(`/token/${token.ticker}`)}
      role="link"
      aria-label={`${token.name} details`}
    >
      {/* Header */}
      <div className="row between" style={{ alignItems: "flex-start" }}>
        <div className="row gap-3">
          <TokenIcon ticker={token.ticker} color={token.color} size={40} />
          <div>
            <div className="row gap-2">
              <span style={{ fontWeight: 600, fontSize: "0.98rem" }}>{token.name}</span>
              <span className="faint" style={{ fontSize: "0.82rem", fontWeight: 600 }}>
                {token.ticker}
              </span>
            </div>
            <div className="row gap-2" style={{ marginTop: 4 }}>
              <span className="badge" style={{ height: 21, padding: "0 7px", fontSize: "0.68rem" }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: chain.color }} />
                {chain.short}
              </span>
              {token.fairLaunch && (
                <span className="badge" style={{ height: 21, padding: "0 7px", fontSize: "0.68rem" }}>
                  Fair launch
                </span>
              )}
            </div>
          </div>
        </div>
        <button
          className={`icon-btn${fav ? " fav" : ""}`}
          style={{ width: 30, height: 30, marginTop: -2, marginRight: -4 }}
          aria-label={fav ? "Remove favorite" : "Add favorite"}
          aria-pressed={fav}
          onClick={(e) => {
            e.stopPropagation();
            toggleFavorite(token.ticker);
          }}
        >
          <Icon name="star" size={16} className={fav ? "fav-fill" : ""} />
        </button>
      </div>

      {/* Metrics */}
      <div className="grid-3" style={{ gap: 8 }}>
        {[
          ["MCap", fmtUsd(token.marketCap, { compact: true })],
          ["Liquidity", fmtUsd(token.liquidity, { compact: true })],
          ["Vol 24h", fmtUsd(token.volume24h, { compact: true })],
        ].map(([k, v]) => (
          <div key={k} className="card inner" style={{ padding: "8px 10px" }}>
            <div className="faint" style={{ fontSize: "0.68rem", fontWeight: 600 }}>{k}</div>
            <div className="tnum" style={{ fontSize: "0.88rem", fontWeight: 600, marginTop: 1 }}>{v}</div>
          </div>
        ))}
      </div>

      {/* Progress to graduation */}
      <div>
        <div className="row between" style={{ marginBottom: 6 }}>
          <span className="faint" style={{ fontSize: "0.74rem", fontWeight: 600 }}>
            {token.status === "graduated" ? "Graduated to DEX" : "Graduation progress"}
          </span>
          <span
            className="tnum"
            style={{
              fontSize: "0.74rem",
              fontWeight: 700,
              color: token.status === "graduated" ? "var(--warn)" : "var(--accent)",
            }}
          >
            {Math.round(token.progress)}%
          </span>
        </div>
        <div className={`progress${token.status === "graduated" ? " graduated" : ""}`}>
          <span style={{ width: `${token.progress}%` }} />
        </div>
      </div>

      {/* Footer */}
      <div className="row between" style={{ marginTop: "auto" }}>
        <div style={{ fontSize: "0.76rem" }} className="faint">
          <span className="mono">{shortAddr(token.creator)}</span>
          <span> · {timeAgo(token.createdAt)}</span>
        </div>
        <div className="row gap-2">
          <span className={`tnum ${token.change24h >= 0 ? "up-text" : "down-text"}`} style={{ fontSize: "0.82rem", fontWeight: 700 }}>
            {fmtPct(token.change24h)}
          </span>
          <button
            className="btn btn-primary btn-sm"
            onClick={(e) => {
              e.stopPropagation();
              onQuickBuy(token);
            }}
          >
            Buy
          </button>
        </div>
      </div>
    </article>
  );
}
