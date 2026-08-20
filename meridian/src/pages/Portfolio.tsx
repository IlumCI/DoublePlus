import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import {
  CREATED_TICKERS,
  POSITIONS,
  portfolioValue,
  positionValue,
  tokenByTicker,
} from "../lib/data";
import { fmtNum, fmtPct, fmtUsd, shortAddr } from "../lib/format";
import { useApp } from "../lib/store";
import { useFakeLoad } from "../lib/hooks";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { Sparkline } from "../components/charts";
import { Icon } from "../components/Icon";
import { StatusBadgeToken } from "../components/TokenCard";
import { TokenIcon } from "../components/TokenIcon";
import { Skeleton } from "../components/ui";
import { WalletModal } from "../components/wallet";

export function Portfolio() {
  const navigate = useNavigate();
  const { wallet, toast } = useApp();
  const loading = useFakeLoad(550);
  const [walletOpen, setWalletOpen] = useState(false);

  const total = portfolioValue();
  const cost = POSITIONS.reduce((s, p) => s + p.costUsd, 0);
  const pnl = total - cost;
  const pnlPct = (pnl / cost) * 100;

  const positions = useMemo(
    () =>
      POSITIONS.map((p) => ({ ...p, token: tokenByTicker(p.ticker)!, value: positionValue(p) }))
        .filter((p) => p.token)
        .sort((a, b) => b.value - a.value),
    []
  );

  const created = CREATED_TICKERS.map((t) => tokenByTicker(t)!).filter(Boolean);
  const earnings = created.reduce((s, t) => s + t.volume24h * 0.01, 0);

  if (!wallet) {
    return (
      <div className="page container" style={{ display: "grid", placeItems: "center" }}>
        <div style={{ textAlign: "center", maxWidth: 400 }}>
          <span style={{ display: "inline-flex", padding: 15, borderRadius: "50%", background: "var(--surface-2)", color: "var(--text-2)" }}>
            <Icon name="briefcase" size={26} />
          </span>
          <h2 className="h1" style={{ marginTop: 18 }}>Connect to view your portfolio</h2>
          <p className="muted" style={{ marginTop: 10, fontSize: "0.94rem" }}>
            Your positions, launches and creator earnings in one place.
          </p>
          <button className="btn btn-primary btn-lg" style={{ marginTop: 22 }} onClick={() => setWalletOpen(true)}>
            <Icon name="wallet" size={16} />
            Connect wallet
          </button>
        </div>
        <WalletModal open={walletOpen} onClose={() => setWalletOpen(false)} />
      </div>
    );
  }

  return (
    <div className="page container">
      <div className="row between wrap" style={{ gap: 12, marginBottom: 22 }}>
        <div>
          <h1 className="h1">Portfolio</h1>
          <div className="row gap-2" style={{ marginTop: 6 }}>
            <span className="mono muted" style={{ fontSize: "0.84rem" }}>{shortAddr(wallet.address)}</span>
            <button
              className="icon-btn"
              style={{ width: 26, height: 26 }}
              aria-label="Copy address"
              onClick={() => {
                navigator.clipboard?.writeText(wallet.address).catch(() => {});
                toast({ kind: "success", title: "Address copied" });
              }}
            >
              <Icon name="copy" size={13} />
            </button>
          </div>
        </div>
        <Link to="/create" className="btn btn-primary">
          <Icon name="plus" size={16} />
          Create token
        </Link>
      </div>

      {/* Summary cards ---------------------------------------------------- */}
      <div className="grid-3" style={{ marginBottom: 24 }}>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="card-title">Total value</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>
            <AnimatedNumber value={total} format={(v) => fmtUsd(v)} duration={900} />
          </div>
        </div>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="card-title">Unrealized P&L</div>
          <div className="row gap-2" style={{ marginTop: 4 }}>
            <span className={`tnum ${pnl >= 0 ? "up-text" : "down-text"}`} style={{ fontSize: "1.5rem", fontWeight: 700 }}>
              {pnl >= 0 ? "+" : "−"}{fmtUsd(Math.abs(pnl))}
            </span>
            <span className={`badge ${pnl >= 0 ? "up" : "down"}`}>{fmtPct(pnlPct)}</span>
          </div>
        </div>
        <div className="card" style={{ padding: "16px 18px" }}>
          <div className="card-title">Creator earnings (24h)</div>
          <div style={{ fontSize: "1.5rem", fontWeight: 700, marginTop: 4 }}>
            <AnimatedNumber value={earnings} format={(v) => fmtUsd(v)} duration={900} />
          </div>
        </div>
      </div>

      {/* Positions -------------------------------------------------------- */}
      <h2 className="h3" style={{ marginBottom: 12 }}>Positions</h2>
      <div className="card" style={{ padding: 0, marginBottom: 32 }}>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th className="num">Balance</th>
                <th className="num">Price</th>
                <th className="num">24h</th>
                <th className="num">Cost</th>
                <th className="num">Value</th>
                <th className="num">Last 48h</th>
              </tr>
            </thead>
            <tbody>
              {loading
                ? Array.from({ length: 4 }).map((_, i) => (
                    <tr key={i}>
                      <td colSpan={7}><Skeleton h={30} /></td>
                    </tr>
                  ))
                : positions.map((p) => (
                    <tr key={p.ticker} className="clickable" onClick={() => navigate(`/token/${p.ticker}`)}>
                      <td>
                        <div className="row gap-3">
                          <TokenIcon ticker={p.token.ticker} color={p.token.color} size={30} />
                          <div>
                            <span style={{ fontWeight: 600 }}>{p.token.name}</span>
                            <span className="faint" style={{ marginLeft: 7, fontSize: "0.8rem" }}>{p.ticker}</span>
                          </div>
                        </div>
                      </td>
                      <td className="num muted">{fmtNum(p.amount)}</td>
                      <td className="num">{fmtUsd(p.token.price)}</td>
                      <td className={`num ${p.token.change24h >= 0 ? "up-text" : "down-text"}`}>
                        {fmtPct(p.token.change24h)}
                      </td>
                      <td className="num muted">{fmtUsd(p.costUsd)}</td>
                      <td className="num" style={{ fontWeight: 600 }}>{fmtUsd(p.value)}</td>
                      <td>
                        <div style={{ display: "flex", justifyContent: "flex-end" }}>
                          <Sparkline data={p.token.series} positive={p.token.change24h >= 0} width={100} height={30} />
                        </div>
                      </td>
                    </tr>
                  ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Created tokens --------------------------------------------------- */}
      <h2 className="h3" style={{ marginBottom: 12 }}>Your launches</h2>
      <div className="grid-2">
        {created.map((t) => (
          <div
            key={t.ticker}
            className="card hover"
            style={{ cursor: "pointer" }}
            onClick={() => navigate(`/token/${t.ticker}`)}
          >
            <div className="row between">
              <div className="row gap-3">
                <TokenIcon ticker={t.ticker} color={t.color} size={38} />
                <div>
                  <div style={{ fontWeight: 600 }}>{t.name}</div>
                  <div className="faint" style={{ fontSize: "0.8rem" }}>{t.ticker}</div>
                </div>
              </div>
              <StatusBadgeToken token={t} />
            </div>
            <div className="grid-3" style={{ gap: 8, marginTop: 14 }}>
              {[
                ["MCap", fmtUsd(t.marketCap, { compact: true })],
                ["Vol 24h", fmtUsd(t.volume24h, { compact: true })],
                ["Your fees (24h)", fmtUsd(t.volume24h * 0.01)],
              ].map(([k, v]) => (
                <div key={k} className="card inner" style={{ padding: "8px 10px" }}>
                  <div className="faint" style={{ fontSize: "0.68rem", fontWeight: 600 }}>{k}</div>
                  <div className="tnum" style={{ fontSize: "0.88rem", fontWeight: 600, marginTop: 1 }}>{v}</div>
                </div>
              ))}
            </div>
            <div style={{ marginTop: 14 }}>
              <div className="row between" style={{ marginBottom: 6 }}>
                <span className="faint" style={{ fontSize: "0.74rem", fontWeight: 600 }}>
                  {t.status === "graduated" ? "Graduated" : "Graduation progress"}
                </span>
                <span className="tnum" style={{ fontSize: "0.74rem", fontWeight: 700, color: t.status === "graduated" ? "var(--warn)" : "var(--accent)" }}>
                  {Math.round(t.progress)}%
                </span>
              </div>
              <div className={`progress${t.status === "graduated" ? " graduated" : ""}`}>
                <span style={{ width: `${t.progress}%` }} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
