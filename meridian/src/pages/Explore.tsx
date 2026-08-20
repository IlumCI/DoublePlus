import { useEffect, useMemo, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { chainById, CHAINS, STATS, TOKENS, type ChainId, type LaunchToken } from "../lib/data";
import { fmtNum, fmtUsd, shortAddr, timeAgo } from "../lib/format";
import { useApp } from "../lib/store";
import { useFakeLoad } from "../lib/hooks";
import { AnimatedNumber } from "../components/AnimatedNumber";
import { Icon } from "../components/Icon";
import { TokenCard, StatusBadgeToken } from "../components/TokenCard";
import { TokenIcon } from "../components/TokenIcon";
import { Modal, ModalHeader, Skeleton } from "../components/ui";

type Category = "trending" | "newest" | "graduated" | "fair" | "favorites";
type SortKey = "newest" | "marketCap" | "volume24h" | "liquidity";

const STAT_CARDS = [
  { label: "Live tokens", value: STATS.liveTokens, fmt: (v: number) => Math.round(v).toLocaleString() },
  { label: "Total volume", value: STATS.totalVolume, fmt: (v: number) => fmtUsd(v, { compact: true }) },
  { label: "Tokens created", value: STATS.tokensCreated, fmt: (v: number) => fmtNum(v, 0) },
  { label: "24h volume", value: STATS.volume24h, fmt: (v: number) => fmtUsd(v, { compact: true }) },
];

const SORTS: Array<{ key: SortKey; label: string }> = [
  { key: "newest", label: "Newest" },
  { key: "marketCap", label: "Market cap" },
  { key: "volume24h", label: "Volume" },
  { key: "liquidity", label: "Liquidity" },
];

function QuickBuyModal({
  token,
  onClose,
}: {
  token: LaunchToken | null;
  onClose: () => void;
}) {
  const { toast, wallet } = useApp();
  const [amount, setAmount] = useState("50");

  if (!token) return null;
  const usd = Number(amount) || 0;

  return (
    <Modal open onClose={onClose}>
      <ModalHeader title={`Buy ${token.ticker}`} onClose={onClose} />
      <div className="row gap-3" style={{ marginBottom: 16 }}>
        <TokenIcon ticker={token.ticker} color={token.color} size={36} />
        <div>
          <div style={{ fontWeight: 600 }}>{token.name}</div>
          <div className="faint" style={{ fontSize: "0.8rem" }}>
            {fmtUsd(token.price)} · {chainById(token.chain).name}
          </div>
        </div>
      </div>
      <label className="field-label">Amount (USD)</label>
      <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
      <div className="row gap-2" style={{ marginTop: 10 }}>
        {[25, 50, 100, 250].map((v) => (
          <button key={v} className="chip" onClick={() => setAmount(String(v))}>
            ${v}
          </button>
        ))}
      </div>
      <div className="card inner" style={{ padding: 14, margin: "16px 0 18px" }}>
        {[
          ["You receive", `≈ ${fmtNum(usd / token.price)} ${token.ticker}`],
          ["Network fee", "$0.004"],
          ["Max slippage", "1.0%"],
        ].map(([k, v]) => (
          <div key={k} className="row between" style={{ padding: "5px 0", fontSize: "0.88rem" }}>
            <span className="muted">{k}</span>
            <span className="tnum" style={{ fontWeight: 600 }}>{v}</span>
          </div>
        ))}
      </div>
      <button
        className="btn btn-primary"
        style={{ width: "100%" }}
        disabled={!wallet || usd <= 0}
        onClick={() => {
          onClose();
          toast({
            kind: "success",
            title: "Buy order filled",
            body: `${fmtUsd(usd)} of ${token.ticker} at ${fmtUsd(token.price)}`,
          });
        }}
      >
        {wallet ? `Buy ${token.ticker}` : "Connect a wallet to buy"}
      </button>
    </Modal>
  );
}

export function Explore() {
  const navigate = useNavigate();
  const loading = useFakeLoad(600);
  const { favorites } = useApp();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useState(params.get("q") ?? "");
  const [category, setCategory] = useState<Category>("trending");
  const [chainFilter, setChainFilter] = useState<ChainId | "all">("all");
  const [sortKey, setSortKey] = useState<SortKey>("newest");
  const [quickBuy, setQuickBuy] = useState<LaunchToken | null>(null);

  // Keep the local search box in sync with ?q= set by the nav search.
  useEffect(() => {
    setQuery(params.get("q") ?? "");
  }, [params]);

  const rows = useMemo(() => {
    let list = TOKENS.filter(
      (t) =>
        t.name.toLowerCase().includes(query.toLowerCase()) ||
        t.ticker.toLowerCase().includes(query.toLowerCase())
    );
    if (chainFilter !== "all") list = list.filter((t) => t.chain === chainFilter);
    if (category === "graduated") list = list.filter((t) => t.status === "graduated");
    if (category === "fair") list = list.filter((t) => t.fairLaunch);
    if (category === "favorites") list = list.filter((t) => favorites.includes(t.ticker));

    const sorted = [...list];
    if (category === "trending" && sortKey === "newest") {
      sorted.sort((a, b) => b.volume24h - a.volume24h);
    } else if (sortKey === "newest") {
      sorted.sort((a, b) => b.createdAt - a.createdAt);
    } else {
      sorted.sort((a, b) => b[sortKey] - a[sortKey]);
    }
    if (category === "newest") sorted.sort((a, b) => b.createdAt - a.createdAt);
    return sorted;
  }, [query, category, chainFilter, sortKey, favorites]);

  const recent = useMemo(
    () => [...TOKENS].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6),
    []
  );

  const setSearch = (v: string) => {
    setQuery(v);
    setParams(v ? { q: v } : {}, { replace: true });
  };

  return (
    <div className="page container">
      {/* Statistics ------------------------------------------------------- */}
      <div className="grid-4" style={{ marginBottom: 24 }}>
        {STAT_CARDS.map((s) => (
          <div key={s.label} className="card" style={{ padding: "16px 18px" }}>
            <div className="card-title">{s.label}</div>
            <div style={{ fontSize: "1.5rem", fontWeight: 700, letterSpacing: "-0.02em", marginTop: 4 }}>
              <AnimatedNumber value={s.value} format={s.fmt} duration={900} />
            </div>
          </div>
        ))}
      </div>

      {/* Filters ---------------------------------------------------------- */}
      <div className="row between wrap" style={{ gap: 12, marginBottom: 14 }}>
        <div className="row gap-2 wrap">
          {(
            [
              ["trending", "Trending", "flame"],
              ["newest", "Newest", "clock"],
              ["graduated", "Graduated", "rocket"],
              ["fair", "Fair launch", "shield"],
              ["favorites", "Favorites", "star"],
            ] as Array<[Category, string, string]>
          ).map(([key, label, icon]) => (
            <button
              key={key}
              className={`chip${category === key ? " active" : ""}`}
              onClick={() => setCategory(key)}
              aria-pressed={category === key}
            >
              <Icon name={icon} size={14} />
              {label}
            </button>
          ))}
        </div>
        <div className="search-wrap" style={{ maxWidth: 250 }}>
          <Icon name="search" size={16} />
          <input
            className="input"
            style={{ height: 38 }}
            placeholder="Search tokens…"
            value={query}
            onChange={(e) => setSearch(e.target.value)}
            aria-label="Search tokens"
          />
        </div>
      </div>

      <div className="row between wrap" style={{ gap: 12, marginBottom: 18 }}>
        <div className="row gap-2 wrap">
          <button
            className={`chip${chainFilter === "all" ? " active" : ""}`}
            onClick={() => setChainFilter("all")}
          >
            All chains
          </button>
          {CHAINS.map((c) => (
            <button
              key={c.id}
              className={`chip${chainFilter === c.id ? " active" : ""}`}
              onClick={() => setChainFilter(c.id)}
            >
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: c.color }} />
              {c.short}
            </button>
          ))}
        </div>
        <div className="seg" role="tablist" aria-label="Sort">
          {SORTS.map((s) => (
            <button
              key={s.key}
              className={sortKey === s.key ? "active" : ""}
              onClick={() => setSortKey(s.key)}
              role="tab"
              aria-selected={sortKey === s.key}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {/* Token grid ------------------------------------------------------- */}
      {loading ? (
        <div className="token-grid">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="card">
              <div className="row gap-3">
                <Skeleton w={40} h={40} r={12} />
                <div style={{ flex: 1 }}>
                  <Skeleton w="60%" />
                  <Skeleton w="35%" h={11} style={{ marginTop: 7 }} />
                </div>
              </div>
              <Skeleton h={48} style={{ marginTop: 14 }} />
              <Skeleton h={6} r={99} style={{ marginTop: 14 }} />
              <div className="row between" style={{ marginTop: 14 }}>
                <Skeleton w={110} h={12} />
                <Skeleton w={64} h={30} r={9} />
              </div>
            </div>
          ))}
        </div>
      ) : rows.length === 0 ? (
        <div className="card" style={{ textAlign: "center", padding: "56px 24px" }}>
          <span style={{ display: "inline-flex", padding: 14, borderRadius: "50%", background: "var(--surface-2)", color: "var(--text-2)" }}>
            <Icon name="search" size={24} />
          </span>
          <h3 className="h3" style={{ marginTop: 16 }}>No tokens found</h3>
          <p className="muted" style={{ marginTop: 6, fontSize: "0.9rem" }}>
            {category === "favorites" && favorites.length === 0
              ? "Star a token to add it to your favorites."
              : "Try a different search or filter."}
          </p>
        </div>
      ) : (
        <div className="token-grid">
          {rows.map((t) => (
            <TokenCard key={t.ticker} token={t} onQuickBuy={setQuickBuy} />
          ))}
        </div>
      )}

      {/* Recent launches -------------------------------------------------- */}
      <div className="row between" style={{ margin: "36px 0 14px" }}>
        <h2 className="h3">Recent launches</h2>
        <span className="faint" style={{ fontSize: "0.84rem" }}>Updated live</span>
      </div>
      <div className="card" style={{ padding: 0 }}>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>Token</th>
                <th>Status</th>
                <th className="num">MCap</th>
                <th className="num">Vol 24h</th>
                <th className="num">Progress</th>
                <th>Creator</th>
                <th className="num">Age</th>
              </tr>
            </thead>
            <tbody>
              {(loading ? [] : recent).map((t) => (
                <tr key={t.ticker} className="clickable" onClick={() => navigate(`/token/${t.ticker}`)}>
                  <td>
                    <div className="row gap-3">
                      <TokenIcon ticker={t.ticker} color={t.color} size={30} />
                      <div>
                        <span style={{ fontWeight: 600 }}>{t.name}</span>
                        <span className="faint" style={{ marginLeft: 7, fontSize: "0.8rem" }}>{t.ticker}</span>
                      </div>
                    </div>
                  </td>
                  <td><StatusBadgeToken token={t} /></td>
                  <td className="num">{fmtUsd(t.marketCap, { compact: true })}</td>
                  <td className="num muted">{fmtUsd(t.volume24h, { compact: true })}</td>
                  <td className="num">
                    <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
                      <div className={`progress${t.status === "graduated" ? " graduated" : ""}`} style={{ width: 70 }}>
                        <span style={{ width: `${t.progress}%` }} />
                      </div>
                      <span className="tnum faint" style={{ fontSize: "0.78rem", width: 34, textAlign: "right" }}>
                        {Math.round(t.progress)}%
                      </span>
                    </div>
                  </td>
                  <td className="mono faint" style={{ fontSize: "0.8rem" }}>{shortAddr(t.creator)}</td>
                  <td className="num faint">{timeAgo(t.createdAt)}</td>
                </tr>
              ))}
              {loading &&
                Array.from({ length: 4 }).map((_, i) => (
                  <tr key={i}>
                    <td colSpan={7}><Skeleton h={30} /></td>
                  </tr>
                ))}
            </tbody>
          </table>
        </div>
      </div>

      {quickBuy && <QuickBuyModal token={quickBuy} onClose={() => setQuickBuy(null)} />}
    </div>
  );
}
