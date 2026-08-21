import { lazy, Suspense, useCallback, useEffect, useState } from "react";
import { formatUnits } from "viem";
import { useParams } from "react-router-dom";
import { useHolders, useToken } from "@launchpad/sdk/react";
import type { Address, TokenSummary } from "@launchpad/sdk";

// The chart is lazy-loaded so the token header, stats and trade panel paint
// immediately and the TradingView chart streams in a beat later.
const TVChart = lazy(() =>
  import("../components/TVChart").then((m) => ({ default: m.TVChart })),
);
import { AnimatedNumber } from "../components/AnimatedNumber";
import { Icon } from "../components/Icon";
import { ShareMenu } from "../components/ShareMenu";
import { StockLogo } from "../components/StockLogo";
import { TokenLogo } from "../components/TokenLogo";
import { TradePanel } from "../components/TradePanel";
import { BaseTradePanel } from "../components/BaseTradePanel";
import { IS_STOCK_BOARD } from "../lib/brand";
import { TradesList } from "../components/TradesList";
import { Button, EmptyState, Skeleton } from "../components/ui";
import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { compact, fmtTokens, fmtUsd, fmtWei, fmtWeiUsd, shortAddr, timeAgo, usdRateOf } from "../lib/format";
import { normalizeSocial } from "../lib/links";
import { isOfficial } from "../lib/official";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { stockOf } from "../lib/v4/stocks";
import { useUi } from "../store";


/** Trades + Holders tab block under the chart. */
function ActivityTabs({ t, usdRate }: { t: TokenSummary; usdRate: number }) {
  const [tab, setTab] = useState<"trades" | "holders">("trades");
  return (
    <section className="mt-6">
      <div className="mb-2 flex items-center gap-2">
        {(["trades", "holders"] as const).map((x) => (
          <button key={x} onClick={() => setTab(x)}
            className={`rounded-full border-2 px-4 py-1.5 text-[12.5px] font-extrabold ${tab === x ? "border-edge-2 bg-edge-2 text-bg" : "border-edge-2 text-ink"}`}
            style={tab === x ? { background: "var(--color-ink)", color: "var(--color-bg)" } : undefined}>
            {x === "trades" ? "Recent trades" : "Holders"}
          </button>
        ))}
      </div>
      <div className="overflow-hidden rounded-2xl border border-edge bg-panel">
        {tab === "trades"
          ? <TradesList token={t.address as Address} symbol={t.symbol} usdRate={usdRate} />
          : <HoldersList token={t.address as Address} symbol={t.symbol} />}
      </div>
    </section>
  );
}

function HoldersList({ token, symbol }: { token: Address; symbol: string }) {
  const { data: holders, loading } = useHolders(client, token, 50);
  if (loading) return <div className="p-4"><Skeleton className="h-8" /><Skeleton className="mt-2 h-8" /></div>;
  if (!holders || holders.length === 0) {
    return <EmptyState title="No holders yet" body="Holders appear as soon as trading starts." />;
  }
  return (
    <table className="w-full text-left">
      <thead>
        <tr className="border-b border-edge text-[9.5px] uppercase tracking-wider text-ink-3">
          <th className="px-3 py-2 font-medium">#</th>
          <th className="px-2 py-2 font-medium">Wallet</th>
          <th className="px-2 py-2 text-right font-medium">{symbol}</th>
          <th className="px-3 py-2 text-right font-medium">% supply</th>
        </tr>
      </thead>
      <tbody>
        {holders.map((h, i) => (
          <tr key={h.address} className="border-b border-edge/50 last:border-0">
            <td className="mono px-3 py-2.5 text-[12px] text-ink-3">{i + 1}</td>
            <td className="px-2 py-2.5">
              <a href={`${env.explorerUrl}/address/${h.address}`} target="_blank" rel="noreferrer" className="mono text-[12px] text-ink hover:underline">
                {shortAddr(h.address)}
              </a>
            </td>
            <td className="mono px-2 py-2.5 text-right text-[12px] text-ink">{fmtTokens(h.balance)}</td>
            <td className="mono px-3 py-2.5 text-right text-[12px] text-ink-2">{h.pct.toFixed(2)}%</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

const IS_STABLE = String(import.meta.env.VITE_PROTOCOL ?? "") === "stable-v3";
const CREATOR_MODE = IS_STABLE || String(import.meta.env.VITE_FEE_MODE ?? "") === "creator";

/** Stable: permissionless harvest strip. The 1% pool fee accrues inside the
 *  held position; anyone can trigger the split; 80% is pushed straight to
 *  the creator's wallet, 20% to the platform. No claim balance to manage. */
function HarvestStrip({ token, creator }: { token: Address; creator: string }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);
  const isCreator = address && creator && address.toLowerCase() === creator.toLowerCase();

  const harvest = async () => {
    if (!isConnected) return connectFirst();
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      // Stable V3 routes the split through the factory; the V4 hook does it
      // in `harvest`. Both push 80% to the creator in the same transaction.
      const hash = await (client as any)[IS_STABLE ? "claimCreatorFees" : "harvest"](token);
      pushToast({ kind: "info", title: "Harvest submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Fees distributed: 80% creator, 20% platform", txHash: hash });
    } catch (err) {
      pushToast({ kind: "error", title: "Harvest failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.04] px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">
          {isCreator ? "Your creator fees" : "Creator fees"}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          Every trade's 1% pool fee accrues here. Harvest anytime: 80% goes straight to the
          creator's wallet, 20% to the platform.
        </p>
      </div>
      <button
        onClick={harvest}
        disabled={busy}
        className="rounded-lg bg-accent px-4 py-2 text-[12.5px] font-semibold text-accent-fg disabled:opacity-50"
      >
        {busy ? "Harvesting…" : "Harvest fees"}
      </button>
    </div>
  );
}

/** V4 reward/fee facts for a token, read from the hook + token in one pass. */
interface Extra {
  stock: Address;
  taxBps: number;
  totalRewards: bigint;
  creatorFees: bigint;
}

// Design-preview token (only used when VITE_PREVIEW=1; never in production).
const PREVIEW_TOKEN = {
  address: "0xb200000000000000000000d7386d4d98a2386ff6",
  name: "Koi King", symbol: "KOI", creator: "0x7a11e0000000000000000000000000000000003f",
  marketCapUsd: "88100", priceUsd: "0.0000881", priceChange24hPct: 27.6,
  volumeTotalWei: String(44300n * 10n ** 18n), volumeTotalUsd: "44300", liquidityWei: String(31000n * 10n ** 18n),
  holderCount: 406, createdAt: Math.floor(Date.now() / 1000) - 90000, txCount24h: 88,
  metadata: { pair: { symbol: "NVDA" }, description: "The pond's finest. Hold KOI, earn NVDA on every trade." },
} as unknown as TokenSummary;

export function TokenPage() {
  const { address } = useParams<{ address: string }>();
  const token = useToken(client, address as Address | undefined);
  const [extra, setExtra] = useState<Extra | null>(null);

  useEffect(() => {
    if (!address) return;
    let live = true;
    const load = () =>
      v4Client
        .tokenExtra(address as Address)
        .then((e) => live && setExtra(e))
        .catch(() => undefined);
    load();
    // Skip refreshes while the tab is backgrounded; no point spending RPC on a
    // page nobody is looking at, and it keeps idle tabs off the endpoint.
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [address]);

  const preview = String(import.meta.env.VITE_PREVIEW ?? "") === "1";
  if (token.loading && !preview) {
    return (
      <div className="mx-auto max-w-[1400px] space-y-3 px-3 py-4 sm:px-4">
        <Skeleton className="h-14" />
        <Skeleton className="h-[460px] rounded-xl" />
      </div>
    );
  }
  if (token.error && !preview) {
    // A failed read is a network problem, not a missing token; say so instead
    // of a misleading not-found, and let the user retry in place.
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-8">
        <EmptyState
          title="Network hiccup"
          body="The RPC endpoint is not responding right now. The token is safe onchain; pull to refresh or try again in a moment."
        />
        <div className="flex justify-center">
          <Button variant="primary" onClick={() => window.location.reload()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  if (!token.data && !preview) {
    return (
      <div className="mx-auto max-w-[1400px] px-4 py-8">
        <EmptyState title="Token not found" body="Check the address, or the indexer may still be catching up." />
      </div>
    );
  }
  const t = (token.data ?? PREVIEW_TOKEN) as TokenSummary;
  const meta = t.metadata ?? {};

  const usdRate = usdRateOf(t);

  const rewardStock = extra ? stockOf(extra.stock) : undefined;
  const metaPair = (meta as any)?.pair as { symbol?: string } | undefined;
  const rewardSym = rewardStock?.symbol ?? metaPair?.symbol;
  const hasReward = !!extra && !/^0x0+$/.test(extra.stock);

  // The koi.fun (Base) flavor uses a dedicated mobile-first token view that
  // mirrors the discovery board: price header, chart, tabbed activity and a
  // sticky Buy/Sell bar. The default flavors keep the desktop two-column view.
  if (IS_STOCK_BOARD) {
    return <BaseTokenView t={t} meta={meta} extra={extra} usdRate={usdRate} rewardSym={rewardSym} hasReward={hasReward} />;
  }

  return (
    <div className="rise mx-auto max-w-6xl px-4 pb-24 sm:px-8">
      {/* Identity */}
      <section className="mt-6 flex items-start gap-3">
        <TokenLogo token={t} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-[20px] font-extrabold leading-tight tracking-tight text-ink sm:text-[24px]">{t.name}</h1>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="mono rounded-md bg-panel-2 px-2 py-0.5 text-[11px] font-semibold text-accent-ink/80">${t.symbol}</span>
            {isOfficial(t.address) && <span className="board-official">OFFICIAL</span>}
            <CaChip address={t.address as Address} />
            {hasReward ? <RewardPill stock={extra!.stock} fallbackSymbol={metaPair?.symbol} /> : null}
          </div>
        </div>
        <ShareMenu address={t.address as Address} symbol={t.symbol} name={t.name} />
      </section>

      {/* About; description, links, facts, creator & pool (no container) */}
      <section className="mt-4">
        <InfoTab t={t} meta={meta} extra={extra} />
      </section>

      <div className="mt-3 space-y-2.5">
        {CREATOR_MODE && <HarvestStrip token={t.address as Address} creator={t.creator} />}
        {!CREATOR_MODE && <RewardsStrip token={t} extra={extra} />}
        {!CREATOR_MODE && (
          <CreatorClaim token={t} extra={extra} onClaimed={() => v4Client.tokenExtra(t.address as Address).then(setExtra).catch(() => undefined)} />
        )}
      </div>

      {/* Chart (with an info header on top) + order ticket */}
      <section className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-[1.6fr_340px]">
        <div className="overflow-hidden rounded-2xl border border-edge bg-panel">
          {/* Info header */}
          <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1.5 border-b border-edge px-4 py-2.5">
            <div className="flex items-center gap-2">
              <span className="text-[13px] font-bold tracking-tight text-ink">Market cap</span>
            </div>
            <div className="flex items-center gap-x-5">
              <HeadStat label="Mcap" accent node={<AnimatedNumber value={Number(t.marketCapUsd)} format={(n) => fmtUsd(n)} className="tnum" />} />
              <HeadStat label="Volume" node={<span className="tnum">{fmtWeiUsd(t.volumeTotalWei, usdRate)}</span>} />
              <HeadStat label="Holders" node={<span className="tnum">{compact(t.holderCount)}</span>} />
              {extra && rewardSym && env.feeMode !== "buyback" ? (
                <HeadStat
                  label={`${rewardSym} to holders`}
                  accent
                  node={<span className="tnum">{fmtTokens(extra.totalRewards.toString())}</span>}
                />
              ) : null}
            </div>
          </div>
          {/* Chart */}
          <div className="hud-viewport h-[420px] overflow-hidden p-1.5">
            <Suspense fallback={<Skeleton className="h-full w-full" />}>
              <TVChart token={t.address as Address} symbol={t.symbol} />
            </Suspense>
          </div>
        </div>
        <div className="lg:sticky lg:top-4 lg:self-start">
          {IS_STOCK_BOARD ? <BaseTradePanel token={t} /> : <TradePanel token={t} />}
        </div>
      </section>

      {/* Trades / Holders */}
      <ActivityTabs t={t} usdRate={usdRate} />
    </div>
  );
}

/* ============================ koi.fun token view ============================ */

const CHEV_L = <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="m15 6-6 6 6 6" /></svg>;

/**
 * Mobile-first token page for koi.fun: a big price header, the live chart,
 * tabbed activity (Trades / Holders / Stats / Info) and a sticky Buy/Sell bar
 * that opens the pair-denominated trade sheet. Same real data and trading as
 * the desktop view, laid out like the discovery board.
 */
const ERC20_META_ABI = [
  { type: "function", name: "decimals", stateMutability: "view", inputs: [], outputs: [{ type: "uint8" }] },
  { type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] },
] as const;

/** Holder-reward claim card: shows the connected wallet's claimable stock for
 *  this coin (streamed from trades, published by the keeper as a Merkle epoch)
 *  and lets them claim it. Hidden when there is nothing to claim. */
function RewardClaimCard({ coin, fallbackSym }: { coin: Address; fallbackSym?: string }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [claimable, setClaimable] = useState<bigint>(0n);
  const [dec, setDec] = useState(18);
  const [sym, setSym] = useState<string>(fallbackSym ?? "");
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!address) { setClaimable(0n); return; }
    try {
      const info = await (v4Client as any).baseRewards(coin, address as Address);
      if (!info) { setClaimable(0n); return; }
      setClaimable(info.claimable);
      if (info.claimable > 0n && /^0x[0-9a-fA-F]{40}$/.test(info.stock) && !/^0x0+$/.test(info.stock)) {
        const [d, s] = await Promise.all([
          (v4Client as any).publicClient.readContract({ address: info.stock, abi: ERC20_META_ABI, functionName: "decimals" }).catch(() => 18),
          (v4Client as any).publicClient.readContract({ address: info.stock, abi: ERC20_META_ABI, functionName: "symbol" }).catch(() => fallbackSym ?? ""),
        ]);
        setDec(Number(d)); setSym(String(s));
      }
    } catch { /* leave as-is */ }
  }, [address, coin, fallbackSym]);

  useEffect(() => { void refresh(); }, [refresh]);

  if (claimable <= 0n) return null;
  const amount = Number(formatUnits(claimable, dec));
  const amountStr = amount >= 1 ? amount.toLocaleString(undefined, { maximumFractionDigits: 4 }) : amount.toPrecision(3);

  const claim = async () => {
    setBusy(true);
    try {
      if (!isConnected) { await connectFirst(); return; }
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hashes = await (v4Client as any).claimBaseRewards(coin, address as Address);
      if (hashes.length === 0) { pushToast({ kind: "info", title: "Nothing to claim yet" }); }
      else { pushToast({ kind: "success", title: `Claimed ${amountStr} ${sym}`, body: "Sent to your wallet.", txHash: hashes[hashes.length - 1] }); }
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="kf-reward-claim">
      <div className="kf-reward-claim-info">
        <span className="kf-reward-claim-label">Your rewards</span>
        <span className="kf-reward-claim-amt">{amountStr} {sym}</span>
      </div>
      <button className="kf-reward-claim-btn" disabled={busy} onClick={claim}>
        {busy ? "Claiming…" : "Claim"}
      </button>
    </div>
  );
}

function BaseTokenView({
  t, meta, extra, usdRate, rewardSym, hasReward,
}: { t: TokenSummary; meta: any; extra: Extra | null; usdRate: number; rewardSym?: string; hasReward: boolean }) {
  const [tab, setTab] = useState<"trades" | "holders" | "stats" | "info">("trades");
  const [sheet, setSheet] = useState<null | "buy" | "sell">(null);
  const chg = t.priceChange24hPct;
  const has = chg != null && isFinite(chg);
  const up = has && chg! >= 0;
  const liqWei = String((t as any).liquidityWei ?? "0");

  const TABS = [
    { id: "trades", label: "Trades" },
    { id: "holders", label: "Holders" },
    { id: "stats", label: "Stats" },
    { id: "info", label: "Info" },
  ] as const;

  return (
    <div className="kf kf-page kf-token">
      {/* Identity */}
      <div className="kf-tk-head">
        <button className="kf-tk-back" aria-label="Back" onClick={() => window.history.length > 1 ? window.history.back() : (window.location.href = "/")}>{CHEV_L}</button>
        <TokenLogo token={t} size={30} />
        <span className="kf-tk-sym">${t.symbol}</span>
        {isOfficial(t.address) && <span className="board-official">OFFICIAL</span>}
        <CaChip address={t.address as Address} />
        <span className="kf-tk-share"><ShareMenu address={t.address as Address} symbol={t.symbol} name={t.name} /></span>
      </div>

      {/* Price */}
      <div className="kf-tk-price">
        <span className="kf-tk-mc">{fmtUsd(t.marketCapUsd)}</span>
        {has && (
          <span className={`kf-tk-chg ${up ? "up" : "down"}`}>
            {up ? "▲" : "▼"} {up ? "+" : ""}{chg!.toFixed(2)}% <i>24h</i>
          </span>
        )}
      </div>
      <div className="kf-tk-line">
        <span>Vol <b>{fmtWeiUsd(t.volumeTotalWei, usdRate)}</b></span>
        <span className="kf-dotsep">·</span>
        <span>Liq <b>{fmtWeiUsd(liqWei, usdRate)}</b></span>
        <span className="kf-dotsep">·</span>
        <span><b>{compact(t.holderCount)}</b> holders</span>
      </div>

      {/* Holder rewards: claim the paired stock streamed from trades */}
      {hasReward ? <RewardClaimCard coin={t.address as Address} fallbackSym={rewardSym} /> : null}

      {/* Chart */}
      <div className="kf-tk-chart">
        <Suspense fallback={<Skeleton className="h-full w-full" />}>
          <TVChart token={t.address as Address} symbol={t.symbol} />
        </Suspense>
      </div>

      {/* Tabs */}
      <div className="kf-tk-tabs" role="tablist">
        {TABS.map((x) => (
          <button key={x.id} role="tab" aria-selected={tab === x.id} className={`kf-tk-tab ${tab === x.id ? "on" : ""}`} onClick={() => setTab(x.id)}>{x.label}</button>
        ))}
      </div>

      <div className="kf-tk-body">
        {tab === "trades" ? <TradesList token={t.address as Address} symbol={t.symbol} usdRate={usdRate} /> : null}
        {tab === "holders" ? <HoldersList token={t.address as Address} symbol={t.symbol} /> : null}
        {tab === "stats" ? <BaseStats t={t} extra={extra} usdRate={usdRate} rewardSym={rewardSym} /> : null}
        {tab === "info" ? <InfoTab t={t} meta={meta} extra={extra} /> : null}
      </div>

      {/* Sticky Buy / Sell */}
      <div className="kf-tk-actions">
        <button className="kf-tk-buy" onClick={() => setSheet("buy")}>Buy</button>
        <button className="kf-tk-sell" onClick={() => setSheet("sell")}>Sell</button>
      </div>

      {sheet ? (
        <div className="kf-sheet-backdrop" onClick={() => setSheet(null)}>
          <div className="kf-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="kf-sheet-grip" />
            <BaseTradePanel token={t} initialSide={sheet} />
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Compact stats grid for the koi token view's Stats tab. */
function BaseStats({ t, extra, usdRate, rewardSym }: { t: TokenSummary; extra: Extra | null; usdRate: number; rewardSym?: string }) {
  const rows: [string, React.ReactNode][] = [
    ["Market cap", fmtUsd(t.marketCapUsd)],
    ["Volume (total)", fmtWeiUsd(t.volumeTotalWei, usdRate)],
    ["Holders", compact(t.holderCount)],
    ["24h change", t.priceChange24hPct != null ? `${t.priceChange24hPct >= 0 ? "+" : ""}${t.priceChange24hPct.toFixed(2)}%` : "—"],
    ["Created", t.createdAt ? timeAgo(t.createdAt) : "—"],
    ["Creator", shortAddr(t.creator)],
  ];
  if (extra && rewardSym && env.feeMode !== "buyback") rows.push([`${rewardSym} to holders`, fmtTokens(extra.totalRewards.toString())]);
  return (
    <div className="kf-stats-grid">
      {rows.map(([k, v]) => (
        <div key={k} className="kf-stat-cell"><span className="k">{k}</span><span className="v">{v}</span></div>
      ))}
    </div>
  );
}

/** Small copyable contract-address chip for the token identity bar. */
function CaChip({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      onClick={() => {
        navigator.clipboard.writeText(address).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 1400);
        });
      }}
      title={copied ? "Copied" : "Copy contract address"}
      className={`mono flex shrink-0 items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] transition-colors ${
        copied
          ? "border-up/40 bg-up/10 text-up"
          : "border-edge bg-panel-2/50 text-ink-3 hover:border-edge-2 hover:text-ink-2"
      }`}
    >
      <span>{shortAddr(address)}</span>
      <Icon name={copied ? "verified" : "copy"} size={11} />
    </button>
  );
}

/** Compact inline stat for the chart header: tiny label, bold value beside it. */
function HeadStat({ label, node, accent }: { label: string; node: React.ReactNode; accent?: boolean }) {
  return (
    <div className="text-right">
      <p className="text-[9px] uppercase tracking-wide text-ink-3">{label}</p>
      <p className={`mono text-[13px] font-bold leading-tight ${accent ? "text-accent-ink" : "text-ink"}`}>{node}</p>
    </div>
  );
}

/** A small "Holders earn {STOCK}" pill for the token identity bar. */
function RewardPill({ stock, fallbackSymbol }: { stock: Address; fallbackSymbol?: string }) {
  const s = stockOf(stock);
  if (/^0x0+$/.test(stock)) return null;
  const symbol = s?.symbol ?? fallbackSymbol;
  if (!symbol) return null;
  const name = s?.name ?? symbol;
  return (
    <span
      title={`Holders earn ${name} (${symbol})`}
      className="flex shrink-0 items-center gap-1.5 rounded-full border border-accent/30 bg-accent/[0.07] py-0.5 pl-0.5 pr-2 text-[11px] font-semibold text-accent-ink"
    >
      <StockLogo address={stock} symbol={symbol} size={16} />
      Earns {symbol}
    </span>
  );
}

/**
 * Holder reward console: the stock every holder earns from trades, how much has
 * been paid out lifetime, and the connected wallet's claimable balance. Anyone
 * can trigger a distribution, which realizes accrued tax into stock rewards.
 */
function RewardsStrip({ token, extra }: { token: TokenSummary; extra: Extra | null }) {
  const { address, isConnected } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [hookPending, setHookPending] = useState<{ coin: bigint; pair: bigint }>({ coin: 0n, pair: 0n });
  const [busy, setBusy] = useState<"claim" | "harvest" | null>(null);

  // The reward = the coin's pair token (a stock or a meme). Prefer the curated
  // stock name, then the pair symbol recorded in the token metadata, then the
  // pair contract's own symbol() (memes like PONS are neither curated nor in
  // metadata).
  const stockRow = extra ? stockOf(extra.stock) : undefined;
  const metaPair = (token.metadata as any)?.pair as { symbol?: string } | undefined;
  const [chainSym, setChainSym] = useState<string | null>(null);
  useEffect(() => {
    setChainSym(null);
    const pair = extra?.stock;
    if (!pair || /^0x0+$/.test(pair) || stockRow || metaPair?.symbol) return;
    let live = true;
    client.publicClient
      .readContract({
        address: pair as Address,
        abi: [{ type: "function", name: "symbol", stateMutability: "view", inputs: [], outputs: [{ type: "string" }] }],
        functionName: "symbol",
      })
      .then((s) => live && setChainSym(String(s)))
      .catch(() => undefined);
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [extra?.stock]);
  const sym = stockRow?.symbol ?? metaPair?.symbol ?? chainSym ?? token.symbol + "-pair";
  const nm = stockRow?.name ?? metaPair?.symbol ?? chainSym ?? "the paired token";

  const refresh = () => {
    // pendingFees exists on the RhClient behind the v4Client facade.
    (v4Client as any)
      .pendingFees(token.address as Address)
      .then(setHookPending)
      .catch(() => undefined);
  };
  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 20_000);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token.address]);

  if (!extra || /^0x0+$/.test(extra.stock)) return null;
  const stock = { symbol: sym, name: nm };

  // Buyback model: no holder rewards. Show the split and a permissionless
  // Harvest that realizes fees (50% creator / 40% buyback-burn / 10% platform).
  if (env.feeMode === "buyback") {
    const harvest = async () => {
      setBusy("harvest");
      try {
        if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
        const hash = await v4Client.harvest(token.address as Address);
        pushToast({ kind: "info", title: "Harvesting fees", txHash: hash });
        await client.publicClient.waitForTransactionReceipt({ hash });
        pushToast({ kind: "success", title: "Fees distributed", body: "Creator paid, buyback funded.", txHash: hash });
      } catch (err) {
        pushToast({ kind: "error", title: "Harvest failed", body: errorText(err) });
      } finally {
        setBusy(null);
      }
    };
    return (
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            Trades against {stock.name} <span className="text-ink-3">({stock.symbol})</span>
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            Every trade fee: <span className="text-accent-ink">50% to the creator</span> in {stock.symbol},
            40% buys back and burns the official token, 10% to the platform.
          </p>
        </div>
        <Button variant="ghost" disabled={busy !== null} onClick={harvest}>
          {busy === "harvest" ? "Harvesting" : "Harvest fees"}
        </Button>
      </div>
    );
  }

  // Launch-to-earn model: base fees accrue in the hook until a claim runs;
  // the claim converts them to ETH and pays the creator 80% directly. The
  // amount shown is the creator's share of what is sitting in the hook now.
  const priceEthWei = BigInt((token as any).priceEthWei ?? "0");
  const coinAsEth = priceEthWei > 0n ? (hookPending.coin * priceEthWei) / 10n ** 18n : 0n;
  const creatorUnclaimed = ((hookPending.pair + coinAsEth) * 2_000n) / 10_000n;
  const usdRate = usdRateOf(token);
  const isCreator = isConnected && address?.toLowerCase() === token.creator.toLowerCase();

  const claimRewards = async () => {
    setBusy("claim");
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await v4Client.harvest(token.address as Address);
      pushToast({ kind: "info", title: "Claim submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({
        kind: "success",
        title: "Rewards claimed",
        body: "80% paid to the creator in ETH; 5% added to the bid wall.",
        txHash: hash,
      });
      refresh();
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="shrink-0 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-edge bg-panel px-4 py-2.5">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-ink">
            {isCreator ? "Your creator rewards" : "Creator rewards"}
          </p>
          <p className="mt-0.5 text-xs text-ink-3">
            20% of every trade fee is the deployer's stream, paid in ETH straight to their
            wallet. Rewards pay out automatically every few minutes, or claim them right now.
          </p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <p className="tnum text-[15px] font-semibold text-ink">{fmtWei(creatorUnclaimed)} ETH</p>
            <p className="tnum text-[11px] text-ink-3">
              {fmtWeiUsd(creatorUnclaimed.toString(), usdRate)} unclaimed
            </p>
          </div>
          <Button variant="primary" disabled={busy !== null || creatorUnclaimed === 0n} onClick={claimRewards}>
            {busy === "claim" ? "Claiming" : "Claim rewards"}
          </Button>
        </div>
      </div>
      <HolderRewards token={token} usdRate={usdRate} />
    </div>
  );
}

/** Flywheel strip: where the other 55% of every fee goes. */
function HolderRewards({ token, usdRate }: { token: TokenSummary; usdRate: number }) {
  const [pot, setPot] = useState(0n);
  const [rank, setRank] = useState<number | null>(null);
  const [vol, setVol] = useState(0n);

  useEffect(() => {
    let live = true;
    const hookAddr = (v4Client as any).v4.hook as Address;
    const abi = [
      { type: "function", name: "communityPot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
      { type: "function", name: "topTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address[3]" }] },
      { type: "function", name: "tokenVol", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
    ] as const;
    const load = async () => {
      try {
        const [p, e] = await Promise.all([
          client.publicClient.readContract({ address: hookAddr, abi, functionName: "communityPot" }),
          client.publicClient.readContract({ address: hookAddr, abi, functionName: "currentEpoch" }),
        ]);
        const [top, v] = await Promise.all([
          client.publicClient.readContract({ address: hookAddr, abi, functionName: "topTokens", args: [e as bigint] }),
          client.publicClient.readContract({ address: hookAddr, abi, functionName: "tokenVol", args: [e as bigint, token.address as Address] }),
        ]);
        if (!live) return;
        setPot(p as bigint);
        setVol(v as bigint);
        const idx = (top as readonly string[]).findIndex((a) => a.toLowerCase() === token.address.toLowerCase());
        setRank(idx >= 0 ? idx + 1 : null);
      } catch {
        /* pre-flywheel deployments */
      }
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, [token.address]);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.04] px-4 py-2.5">
      <div className="min-w-0">
        <p className="text-sm font-semibold text-ink">
          The weekly flywheel{rank ? ` · currently #${rank} for the burn` : ""}
        </p>
        <p className="mt-0.5 text-xs text-ink-3">
          25% of every fee on every coin fills the community pot; each week it buys back and
          burns the top 3 coins by volume (50/30/20). 30% pays traders back in ETH, claimable
          on your Profile. Snipers pay extra straight into the burn pot.
        </p>
      </div>
      <div className="text-right">
        <p className="tnum text-[15px] font-semibold text-ink">{fmtWei(pot)} ETH</p>
        <p className="tnum text-[11px] text-ink-3">
          {fmtWeiUsd(pot.toString(), usdRate)} burn pot · {fmtWei(vol)} ETH volume this week
        </p>
      </div>
    </div>
  );
}

/**
 * Creator's own fee console. Shown only to the wallet that launched the token:
 * it surfaces the claimable creator share (25% of every trade's tax, in WETH)
 * and a one-tap claim. Everyone else never sees it.
 */
function CreatorClaim({
  token,
  extra,
  onClaimed,
}: {
  token: TokenSummary;
  extra: Extra | null;
  onClaimed: () => void;
}) {
  const { address, isConnected } = useWallet();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const isCreator = isConnected && address?.toLowerCase() === token.creator.toLowerCase();
  if (!isCreator || !extra) return null;

  const claimable = extra.creatorFees;
  const usdRate = usdRateOf(token);

  const claim = async () => {
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      const hash = await client.claimCreatorFees(token.address as Address);
      pushToast({ kind: "info", title: "Claim submitted", txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Fees claimed", body: "Sent to your wallet.", txHash: hash });
      onClaimed();
    } catch (err) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 rounded-xl border border-accent/25 bg-accent/[0.04] px-4 py-2.5">
      <div>
        <p className="text-sm font-semibold text-ink">Your creator fees</p>
        <p className="mt-0.5 text-xs text-ink-3">
          You earn 25% of every trade's tax, paid in WETH. Claim anytime, straight to your wallet.
        </p>
      </div>
      <div className="flex items-center gap-3">
        <div className="text-right">
          <p className="tnum text-[15px] font-semibold text-ink">{fmtWei(claimable)} WETH</p>
          <p className="tnum text-[11px] text-ink-3">{fmtWeiUsd(claimable.toString(), usdRate)}</p>
        </div>
        <Button variant="dark" disabled={busy || claimable === 0n} onClick={claim}>
          {busy ? "Claiming" : "Claim fees"}
        </Button>
      </div>
    </div>
  );
}

const socialIcons: Record<string, JSX.Element> = {
  Website: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
      <circle cx="8" cy="8" r="6.25" stroke="currentColor" strokeWidth="1.4" />
      <path d="M1.75 8h12.5M8 1.75c1.8 1.7 2.7 3.9 2.7 6.25S9.8 12.55 8 14.25c-1.8-1.7-2.7-3.9-2.7-6.25S6.2 3.45 8 1.75z" stroke="currentColor" strokeWidth="1.4" />
    </svg>
  ),
  X: (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M9.5 6.8L15 .5h-1.5L8.9 5.9 5.2.5H0l5.9 8.6L0 15.5h1.5l5.1-5.9 4 5.9H16L9.5 6.8zm-1.8 2.1l-.6-.85L2 1.6h2.2l3.8 5.45.6.85 5 7.1h-2.2L7.7 8.9z" />
    </svg>
  ),
  Telegram: (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden>
      <path d="M14.7 1.6L1.3 6.8c-.9.35-.9 1.2 0 1.5l3.4 1.05 1.3 4.1c.25.7.9.85 1.45.35l1.9-1.8 3.5 2.6c.6.35 1.25.1 1.4-.65l2.3-11.1c.2-.95-.55-1.6-1.85-1.25zM5.6 9.1l7.2-4.55c.35-.2.65.05.4.3L7.3 10.4l-.25 2.5-1.45-3.8z" />
    </svg>
  ),
  DexScreener: (
    <img
      src="data:image/png;base64,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"
      alt=""
      width={18}
      height={18}
      className="rounded"
    />
  ),
};

/** DexScreener chain slug for this deployment, empty when the chain isn't
 *  indexed there. Address search is NOT a fallback: token addresses repeat
 *  across chains (deterministic deploys), so a search can land on a
 *  same-address token from a different chain. */
const DEXSCREENER_CHAIN = String(import.meta.env.VITE_DEXSCREENER_CHAIN ?? "");

function InfoTab({ t, meta, extra }: { t: any; meta: any; extra: Extra | null }) {
  const explorer = env.explorerUrl ? env.explorerUrl.replace(/\/$/, "") : "";
  const links: { label: string; url?: string }[] = [
    { label: "Website", url: normalizeSocial(meta.website) },
    { label: "X", url: normalizeSocial(meta.twitter, "x") },
    { label: "Telegram", url: normalizeSocial(meta.telegram, "telegram") },
    ...(meta.links ?? []).map((l: { label: string; url?: string }) => ({ ...l, url: normalizeSocial(l.url) })),
    explorer ? { label: "Scan", url: `${explorer}/token/${t.address}` } : { label: "Scan" },
    DEXSCREENER_CHAIN && t.pool
      ? { label: "DexScreener", url: `https://dexscreener.com/${DEXSCREENER_CHAIN}/${t.pool}` }
      : explorer && t.pool
        ? { label: "Pool", url: `${explorer}/address/${t.pool}` }
        : { label: "Pool" },
  ].filter((l) => l.url);

  return (
    <div className="space-y-4">
      {meta.description ? (
        // Em dashes in stored metadata are normalized at display time (the
        // on-chain string itself can't be edited).
        <p className="text-[13px] leading-6 text-ink-2">{String(meta.description).replace(/\s*—\s*/g, " - ")}</p>
      ) : null}

      {links.length > 0 ? (
        <div className="flex flex-wrap gap-4">
          {links.map((l) => (
            <a
              key={l.label + l.url}
              href={String(l.url)}
              target="_blank"
              rel="noreferrer"
              title={l.label}
              className="flex items-center gap-1.5 text-[12px] font-medium text-ink-2 transition-colors hover:text-ink"
            >
              <span className="grid h-4 w-4 place-items-center text-ink-2">
                {socialIcons[l.label] ?? socialIcons.Website}
              </span>
              {l.label}
            </a>
          ))}
        </div>
      ) : null}

      <p className="text-[12px] text-ink-3">
        Created by{" "}
        {explorer ? (
          <a
            href={`${explorer}/address/${t.creator}`}
            target="_blank"
            rel="noreferrer"
            className="mono font-medium text-ink-2 underline underline-offset-2 transition-colors hover:text-ink"
          >
            {shortAddr(t.creator)}
          </a>
        ) : (
          <span className="mono font-medium text-ink-2">{shortAddr(t.creator)}</span>
        )}
        {t.createdAt ? <span> · launched {timeAgo(t.createdAt)}</span> : null}
      </p>
    </div>
  );
}

