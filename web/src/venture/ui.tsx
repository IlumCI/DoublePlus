import { useEffect, useState } from "react";

import { TOTAL_SUPPLY, VENTURE, type Venture } from "./client";

/** Flag-on-a-block mark: a raised founder flag. */
export function Flag({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 21V4" stroke="var(--up, #a5dbb2)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6.8 4.6c2.6-1.7 4.9-1.7 7.4 0 2 1.3 3.6 1.4 5.4.5v7c-1.8.9-3.4.8-5.4-.5-2.5-1.7-4.8-1.7-7.4 0z" fill="var(--up, #a5dbb2)" opacity="0.9" />
      <path d="M3.5 21h9" stroke="var(--faint, #6f6c80)" strokeWidth="2" strokeLinecap="round" />
    </svg>
  );
}

/** SVG filter defs the stamps and paper grain reference. Mounted once. */
export function FilterDefs() {
  return (
    <svg width="0" height="0" style={{ position: "absolute" }} aria-hidden>
      <defs>
        <filter id="roughen" x="-8%" y="-8%" width="116%" height="116%">
          <feTurbulence type="fractalNoise" baseFrequency="0.11" numOctaves="2" seed="3" result="n" />
          <feDisplacementMap in="SourceGraphic" in2="n" scale="3.4" />
        </filter>
      </defs>
    </svg>
  );
}

export const fmtEth = (wei: bigint, digits = 5): string => {
  const v = Number(wei) / 1e18;
  if (v === 0) return "0";
  if (v < 0.00001) return v.toExponential(2);
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
};

export const fmtTok = (weiOrWhole: bigint, whole = false): string => {
  const v = whole ? Number(weiOrWhole) : Number(weiOrWhole) / 1e18;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

export const fmtUsdV = (v: number): string =>
  v >= 1_000_000 ? `$${(v / 1e6).toFixed(2)}M`
    : v >= 1000 ? `$${(v / 1000).toFixed(1)}K`
    : v >= 1 ? `$${v.toFixed(2)}`
    : `$${v.toFixed(4)}`;

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const pct = (num: bigint, den: bigint): number =>
  den === 0n ? 0 : Math.min(100, Number((num * 10_000n) / den) / 100);

/** Fully-diluted value from the curve price — what a launchpad calls market cap. */
export const fdvWei = (v: Venture): bigint => v.priceWei * BigInt(TOTAL_SUPPLY);

/** ETH/USD for headline numbers, resolved once per session. Testnet explorers
 *  cannot price their own WETH, so the env-configured fallback stands in. */
let ethUsdCache = 0;
let ethUsdInflight: Promise<number> | null = null;

function resolveEthUsd(): Promise<number> {
  if (ethUsdInflight) return ethUsdInflight;
  ethUsdInflight = import("../lib/rh/routes")
    .then(({ pairUsd }) => import("./client").then(({ venturePc }) => pairUsd(VENTURE.weth, venturePc)))
    .then((v) => (v > 0 ? v : 0))
    .catch(() => 0);
  return ethUsdInflight;
}

export function useEthUsd(): number {
  const fallback = Number(VENTURE.ethUsd8Fallback) / 1e8;
  const [usd, setUsd] = useState(() => ethUsdCache || fallback);
  useEffect(() => {
    if (ethUsdCache) return;
    let live = true;
    resolveEthUsd().then((v) => {
      if (v > 0) ethUsdCache = v;
      if (live && v > 0) setUsd(v);
    });
    return () => { live = false; };
  }, [fallback]);
  return usd;
}

export const fmtMcap = (v: Venture, ethUsd: number): string => {
  const eth = Number(fdvWei(v)) / 1e18;
  return ethUsd > 0 ? fmtUsdV(eth * ethUsd) : `${eth.toFixed(3)} ETH`;
};

/** Deterministic monogram tint so a venture keeps the same colour everywhere. */
export function Monogram({ v, size = "sm" }: { v: Venture; size?: "sm" | "lg" }) {
  const tints = ["", "m2", "m3", "m4"];
  const tint = tints[Number(BigInt(v.address) % 4n)];
  const cls = `dp-monogram ${tint ? `dp-${tint}` : ""} ${size === "lg" ? "dp-lg" : ""}`.replace(/\s+/g, " ").trim();
  if (v.meta.logo) {
    return <span className={cls} style={{ padding: 0, overflow: "hidden", background: "var(--panel-2)" }}>
      <img src={v.meta.logo} alt="" style={{ width: "100%", height: "100%", objectFit: "cover" }} />
    </span>;
  }
  return <span className={cls}>{v.name.slice(0, 1).toUpperCase()}</span>;
}

/** Lifecycle status, in launchpad vocabulary. */
export function StatusBadge({ v }: { v: Venture }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  if (v.phase === "graduated") return <span className="dp-badge dp-grad">trading</span>;
  if (v.phase === "failed") return <span className="dp-badge dp-dead">failed</span>;
  if (v.phase === "expired") return <span className="dp-badge dp-soon">funded</span>;
  if (funded >= 85) return <span className="dp-badge dp-soon">graduating soon</span>;
  // An open curve has no target to be "live" against — it trades until it fills.
  if (v.mode === 1) return <span className="dp-badge dp-open">open curve</span>;
  return <span className="dp-badge dp-live">live</span>;
}

/** Bonding-curve progress, the meter every launchpad shows. */
export function CurveBar({ v }: { v: Venture }) {
  const funded = v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei);
  const cls = v.phase === "failed" ? "dp-dead" : funded >= 100 ? "dp-done" : "";
  return <div className={`dp-curvebar ${cls}`} style={{ ["--pct" as string]: `${funded}%` }}><i /></div>;
}

/** Relative age, as launchpads print provenance: "created by X 2m ago". */
export function ago(unixSecs: number): string {
  const s = Math.max(0, Math.floor(Date.now() / 1000) - unixSecs);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h`;
  if (s < 604_800) return `${Math.floor(s / 86_400)}d`;
  return `${Math.floor(s / 604_800)}w`;
}

/** 1s ticker so countdowns animate smoothly. */
export function useTick(): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return Date.now();
}

export function Countdown({ deadline }: { deadline: number }) {
  useTick();
  const left = Math.max(0, deadline - Math.floor(Date.now() / 1000));
  const d = Math.floor(left / 86_400);
  const h = Math.floor((left % 86_400) / 3600);
  const m = Math.floor((left % 3600) / 60);
  const s = left % 60;
  return (
    <span className="dp-mono">
      {d > 0 ? `${d}d ${String(h).padStart(2, "0")}h` : `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`}
    </span>
  );
}

/** ETH with its dollar value beside it — nobody thinks in 0.000002 ETH. */
export function EthUsd({ wei, digits = 4, usd }: { wei: bigint; digits?: number; usd: number }) {
  const eth = Number(wei) / 1e18;
  return (
    <>
      <span className="dp-mono">{fmtEth(wei, digits)} ETH</span>
      {usd > 0 && eth > 0 && <span className="dp-mono" style={{ color: "var(--faint)" }}> · {fmtUsdV(eth * usd)}</span>}
    </>
  );
}

/** Copy-to-clipboard for addresses and links; confirms in place. */
export function CopyButton({ value, label, className }: { value: string; label?: string; className?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className={className ?? "dp-mono"}
      style={{ background: "none", border: "none", padding: 0, color: done ? "var(--up)" : "inherit", cursor: "pointer" }}
      onClick={() => navigator.clipboard?.writeText(value).then(() => { setDone(true); setTimeout(() => setDone(false), 1400); })}
      title="Copy"
    >
      {done ? "copied ✓" : (label ?? short(value))} ⧉
    </button>
  );
}

/** Percent change between the first and last close in a window. */
export function changePct(points: { close: number }[]): number | null {
  if (points.length < 2) return null;
  const first = points[0].close;
  const last = points[points.length - 1].close;
  if (!(first > 0)) return null;
  return ((last - first) / first) * 100;
}

export function Change({ pct: p }: { pct: number | null }) {
  if (p === null) return <span className="dp-mono" style={{ color: "var(--faint)" }}>—</span>;
  return (
    <span className="dp-mono" style={{ color: p >= 0 ? "var(--up)" : "var(--down)" }}>
      {p >= 0 ? "+" : ""}{p.toFixed(1)}%
    </span>
  );
}

export function CardSkeletons({ n = 8 }: { n?: number }) {
  return <div className="dp-grid">{Array.from({ length: n }, (_, i) => <div key={i} className="dp-skel dp-skel-card" />)}</div>;
}


/** Readable amounts for micro-cap tokens: ETH down to a point, then gwei.
 *  Scientific notation in a trade tape is how you lose a reader. */
export const fmtValue = (wei: bigint): string => {
  const eth = Number(wei) / 1e18;
  if (eth === 0) return "0";
  if (eth >= 0.0001) return `${eth.toLocaleString("en-US", { maximumFractionDigits: 5 })} ETH`;
  const gwei = Number(wei) / 1e9;
  if (gwei >= 0.01) return `${gwei.toLocaleString("en-US", { maximumFractionDigits: 2 })} gwei`;
  return `${Number(wei).toLocaleString("en-US", { maximumFractionDigits: 0 })} wei`;
};


/** The stat strip a trader reads first: price, size, and how it moved.
 *  Dense, monospaced, no prose — the row scans in under a second. */
export function StatCell({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="dp-stat">
      <span className="dp-stat-k">{k}</span>
      <span className="dp-stat-v">{children}</span>
    </div>
  );
}

/** Percent change with the sign baked into the colour. */
export function Delta({ pct: p, size = 13 }: { pct: number | null; size?: number }) {
  if (p === null || !Number.isFinite(p)) return <span className="dp-mono" style={{ color: "var(--faint)", fontSize: size }}>—</span>;
  const big = Math.abs(p) >= 1000;
  return (
    <span className="dp-mono" style={{ color: p >= 0 ? "var(--up)" : "var(--down)", fontSize: size }}>
      {p >= 0 ? "+" : ""}{big ? p.toExponential(1) : p.toFixed(p >= 100 || p <= -100 ? 0 : 2)}%
    </span>
  );
}

/** Buy versus sell pressure over 24h, by value. The bar is the headline and
 *  the counts are the detail — both are what a trader asks for next. */
export function BuySellStrength({ buyWei, sellWei, buys, sells }: {
  buyWei: bigint; sellWei: bigint; buys: number; sells: number;
}) {
  const total = buyWei + sellWei;
  const buyPct = total === 0n ? 50 : Number((buyWei * 10_000n) / total) / 100;
  return (
    <div className="dp-strength">
      <div className="dp-strength-head">
        <span className="dp-up">buys {buys}</span>
        <span className="dp-strength-mid">{total === 0n ? "no trades yet" : `${buyPct.toFixed(0)}% buy pressure`}</span>
        <span className="dp-down">sells {sells}</span>
      </div>
      <div className="dp-strength-bar" role="img" aria-label={`${buyPct.toFixed(0)}% of 24h volume was buys`}>
        <i style={{ width: `${buyPct}%` }} />
        <u style={{ width: `${100 - buyPct}%` }} />
      </div>
      <div className="dp-strength-foot">
        <span>{fmtEth(buyWei, 3)} ETH</span>
        <span>{fmtEth(sellWei, 3)} ETH</span>
      </div>
    </div>
  );
}
