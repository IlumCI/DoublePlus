import { useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { chainById, tokenByTicker, tradesFor } from "../lib/data";
import { fmtNum, fmtPct, fmtUsd, shortAddr, timeAgo } from "../lib/format";
import { useApp } from "../lib/store";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { AreaChart } from "../components/charts";
import { Icon } from "../components/Icon";
import { StatusBadgeToken } from "../components/TokenCard";
import { TokenIcon } from "../components/TokenIcon";
import { Modal, ModalHeader } from "../components/ui";

const RANGES = ["1H", "6H", "24H", "7D"];

export function TokenDetail() {
  const { ticker = "" } = useParams();
  const token = tokenByTicker(ticker);
  const { toast, wallet, favorites, toggleFavorite } = useApp();
  const [range, setRange] = useState("24H");
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amount, setAmount] = useState("50");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const chartData = useMemo(() => {
    if (!token) return [];
    const stretch = { "1H": 0.5, "6H": 0.8, "24H": 1, "7D": 2.2 }[range] ?? 1;
    return token.series.map(
      (v, i) => v * (1 + ((i / token.series.length) * (stretch - 1) * token.change24h) / 100)
    );
  }, [token, range]);

  const trades = useMemo(() => (token ? tradesFor(token.ticker) : []), [token]);

  if (!token) {
    return (
      <div className="page container" style={{ textAlign: "center" }}>
        <h2 className="h1" style={{ marginTop: 60 }}>Token not found</h2>
        <p className="muted" style={{ marginTop: 10 }}>We couldn't find “{ticker}”.</p>
        <Link to="/" className="btn btn-soft" style={{ marginTop: 22 }}>
          Back to explore
        </Link>
      </div>
    );
  }

  const chain = chainById(token.chain);
  const fav = favorites.includes(token.ticker);
  const usd = Number(amount) || 0;

  const stats: Array<[string, string]> = [
    ["Market cap", fmtUsd(token.marketCap, { compact: true })],
    ["Liquidity", fmtUsd(token.liquidity, { compact: true })],
    ["Volume 24h", fmtUsd(token.volume24h, { compact: true })],
    ["Holders", token.holders.toLocaleString()],
    ["Price", fmtUsd(token.price)],
    ["Age", timeAgo(token.createdAt)],
  ];

  const copy = (text: string, title: string) => {
    navigator.clipboard?.writeText(text).catch(() => {});
    toast({ kind: "success", title });
  };

  return (
    <div className="page container">
      <Link to="/" className="muted row gap-2" style={{ fontSize: "0.88rem", marginBottom: 18, display: "inline-flex" }}>
        <Icon name="receive" size={14} />
        Explore
      </Link>

      {/* Header ----------------------------------------------------------- */}
      <div className="row between wrap" style={{ gap: 14, marginBottom: 18 }}>
        <div className="row gap-3">
          <TokenIcon ticker={token.ticker} color={token.color} size={46} />
          <div>
            <div className="row gap-2 wrap">
              <h1 style={{ fontSize: "1.35rem", fontWeight: 700 }}>{token.name}</h1>
              <span className="faint" style={{ fontWeight: 600 }}>{token.ticker}</span>
              <StatusBadgeToken token={token} />
              <span className="badge">
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: chain.color }} />
                {chain.name}
              </span>
            </div>
            <div className="row gap-2" style={{ marginTop: 5 }}>
              <span className="tnum" style={{ fontSize: "1.1rem", fontWeight: 700 }}>
                <AnimatedNumber value={token.price} format={(v) => fmtUsd(v)} duration={700} />
              </span>
              <span className={`badge ${token.change24h >= 0 ? "up" : "down"}`}>
                {fmtPct(token.change24h)} · 24h
              </span>
            </div>
          </div>
        </div>
        <div className="row gap-2">
          {token.website && (
            <button className="icon-btn" aria-label="Website" onClick={() => toast({ kind: "info", title: "Opening website", body: token.website })}>
              <Icon name="globe" size={17} />
            </button>
          )}
          {token.twitter && (
            <button className="icon-btn" aria-label="X profile" onClick={() => toast({ kind: "info", title: "Opening X", body: token.twitter })}>
              <Icon name="link" size={17} />
            </button>
          )}
          {token.telegram && (
            <button className="icon-btn" aria-label="Telegram" onClick={() => toast({ kind: "info", title: "Opening Telegram", body: token.telegram })}>
              <Icon name="send" size={17} />
            </button>
          )}
          <button
            className={`icon-btn${fav ? " fav" : ""}`}
            aria-label={fav ? "Remove favorite" : "Add favorite"}
            aria-pressed={fav}
            onClick={() => toggleFavorite(token.ticker)}
          >
            <Icon name="star" size={17} className={fav ? "fav-fill" : ""} />
          </button>
        </div>
      </div>

      <div className="split-main">
        {/* Left column ---------------------------------------------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          <div className="card">
            <div className="row between wrap" style={{ gap: 10, marginBottom: 14 }}>
              <h3 className="h3">Price</h3>
              <div className="seg" role="tablist" aria-label="Chart range">
                {RANGES.map((r) => (
                  <button key={r} className={r === range ? "active" : ""} onClick={() => setRange(r)} role="tab" aria-selected={r === range}>
                    {r}
                  </button>
                ))}
              </div>
            </div>
            <AreaChart data={chartData} height={280} />
          </div>

          {/* Graduation progress */}
          <div className="card">
            <div className="row between" style={{ marginBottom: 8 }}>
              <span className="card-title">
                {token.status === "graduated" ? "Graduated — trading on DEX" : "Graduation progress"}
              </span>
              <span
                className="tnum"
                style={{ fontWeight: 700, fontSize: "0.88rem", color: token.status === "graduated" ? "var(--warn)" : "var(--accent)" }}
              >
                {Math.round(token.progress)}%
              </span>
            </div>
            <div className={`progress${token.status === "graduated" ? " graduated" : ""}`} style={{ height: 8 }}>
              <span style={{ width: `${token.progress}%` }} />
            </div>
            <p className="faint" style={{ fontSize: "0.8rem", marginTop: 10 }}>
              {token.status === "graduated"
                ? "Anti-whale limits were lifted automatically when the market cap crossed the graduation threshold."
                : "Anti-whale limits stay active until the market cap crosses $40K, then lift automatically on-chain."}
            </p>
          </div>

          {/* Recent trades */}
          <div className="card" style={{ padding: 0 }}>
            <h3 className="h3" style={{ padding: "18px 20px 10px" }}>Recent trades</h3>
            <div className="table-scroll">
              <table className="table">
                <thead>
                  <tr>
                    <th>Side</th>
                    <th className="num">Value</th>
                    <th className="num">Tokens</th>
                    <th>Wallet</th>
                    <th className="num">Time</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((tr) => (
                    <tr key={tr.id}>
                      <td>
                        <span className={`badge ${tr.side === "buy" ? "up" : "down"}`}>
                          {tr.side === "buy" ? "Buy" : "Sell"}
                        </span>
                      </td>
                      <td className="num" style={{ fontWeight: 600 }}>{fmtUsd(tr.amountUsd)}</td>
                      <td className="num muted">{fmtNum(tr.tokens)} {token.ticker}</td>
                      <td className="mono faint" style={{ fontSize: "0.8rem" }}>{shortAddr(tr.wallet)}</td>
                      <td className="num faint">{timeAgo(tr.ts)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Right column --------------------------------------------------- */}
        <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Buy / Sell panel */}
          <div className="card">
            <div className="seg" style={{ width: "100%", marginBottom: 14 }} role="tablist" aria-label="Trade side">
              <button
                style={{ flex: 1 }}
                className={side === "buy" ? "active" : ""}
                onClick={() => setSide("buy")}
                role="tab"
                aria-selected={side === "buy"}
              >
                Buy
              </button>
              <button
                style={{ flex: 1 }}
                className={side === "sell" ? "active" : ""}
                onClick={() => setSide("sell")}
                role="tab"
                aria-selected={side === "sell"}
              >
                Sell
              </button>
            </div>
            <label className="field-label">Amount (USD)</label>
            <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            <div className="row gap-2" style={{ marginTop: 10, flexWrap: "wrap" }}>
              {[25, 50, 100, 250].map((v) => (
                <button key={v} className="chip" style={{ height: 28, padding: "0 10px" }} onClick={() => setAmount(String(v))}>
                  ${v}
                </button>
              ))}
            </div>
            <div className="row between" style={{ margin: "14px 0 4px", fontSize: "0.85rem" }}>
              <span className="muted">{side === "buy" ? "You receive" : "You sell"}</span>
              <span className="tnum" style={{ fontWeight: 600 }}>
                ≈ {fmtNum(usd / token.price)} {token.ticker}
              </span>
            </div>
            <div className="row between" style={{ marginBottom: 14, fontSize: "0.85rem" }}>
              <span className="muted">Fee (1%)</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{fmtUsd(usd * 0.01)}</span>
            </div>
            <button
              className={`btn ${side === "buy" ? "btn-primary" : "btn-sell"}`}
              style={{ width: "100%" }}
              disabled={!wallet || usd <= 0}
              onClick={() => setConfirmOpen(true)}
            >
              {wallet ? `${side === "buy" ? "Buy" : "Sell"} ${token.ticker}` : "Connect a wallet"}
            </button>
            <p className="faint" style={{ fontSize: "0.74rem", marginTop: 10, textAlign: "center" }}>
              1% trade fee goes to the creator. Liquidity is protocol-managed.
            </p>
          </div>

          {/* Stats */}
          <div className="card">
            <h3 className="h3" style={{ marginBottom: 6 }}>Statistics</h3>
            {stats.map(([k, v]) => (
              <div key={k} className="row between" style={{ padding: "9px 0", borderBottom: "1px solid var(--border)", fontSize: "0.89rem" }}>
                <span className="muted">{k}</span>
                <span className="tnum" style={{ fontWeight: 600 }}>{v}</span>
              </div>
            ))}
            <div className="row between" style={{ padding: "9px 0 0", fontSize: "0.89rem" }}>
              <span className="muted">Contract</span>
              <button className="row gap-2 mono" style={{ fontWeight: 600, color: "var(--text)" }} onClick={() => copy(token.contract, "Contract address copied")}>
                {shortAddr(token.contract)}
                <Icon name="copy" size={14} />
              </button>
            </div>
          </div>

          {/* Creator */}
          <div className="card">
            <h3 className="h3" style={{ marginBottom: 12 }}>Creator</h3>
            <div className="row gap-3">
              <span
                className="token-icon"
                style={{ width: 36, height: 36, borderRadius: "50%", fontSize: 13, background: "var(--surface-3)", color: "var(--text-2)" }}
              >
                {token.creator.slice(2, 4).toUpperCase()}
              </span>
              <div style={{ flex: 1, minWidth: 0 }}>
                <button className="mono" style={{ fontWeight: 600, fontSize: "0.86rem", color: "var(--text)" }} onClick={() => copy(token.creator, "Creator address copied")}>
                  {shortAddr(token.creator)}
                </button>
                <div className="faint" style={{ fontSize: "0.78rem" }}>
                  Earns 1% of every trade
                </div>
              </div>
              <span className="badge accent">Verified</span>
            </div>
            <p className="muted" style={{ fontSize: "0.86rem", lineHeight: 1.6, marginTop: 14 }}>
              {token.description}
            </p>
          </div>
        </div>
      </div>

      {/* Confirm dialog --------------------------------------------------- */}
      <Modal open={confirmOpen} onClose={() => setConfirmOpen(false)}>
        <ModalHeader title={`Confirm ${side}`} onClose={() => setConfirmOpen(false)} />
        <div className="card inner" style={{ padding: 16, marginBottom: 18 }}>
          {[
            [side === "buy" ? "Buying" : "Selling", `≈ ${fmtNum(usd / token.price)} ${token.ticker}`],
            ["Value", fmtUsd(usd)],
            ["Price", fmtUsd(token.price)],
            ["Network", chain.name],
            ["Fee", fmtUsd(usd * 0.01)],
          ].map(([k, v]) => (
            <div key={k} className="row between" style={{ padding: "6px 0", fontSize: "0.9rem" }}>
              <span className="muted">{k}</span>
              <span className="tnum" style={{ fontWeight: 600 }}>{v}</span>
            </div>
          ))}
        </div>
        <div className="row gap-2">
          <button className="btn btn-ghost" style={{ flex: 1 }} onClick={() => setConfirmOpen(false)}>
            Cancel
          </button>
          <button
            className={`btn ${side === "buy" ? "btn-primary" : "btn-sell"}`}
            style={{ flex: 1.3 }}
            onClick={() => {
              setConfirmOpen(false);
              toast({
                kind: "success",
                title: `${side === "buy" ? "Buy" : "Sell"} order filled`,
                body: `${fmtUsd(usd)} of ${token.ticker} at ${fmtUsd(token.price)}`,
              });
            }}
          >
            Confirm
          </button>
        </div>
      </Modal>
    </div>
  );
}
