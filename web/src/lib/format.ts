import { env } from "./env";

export function shortAddr(addr: string): string {
  return addr.length > 12 ? `${addr.slice(0, 6)}...${addr.slice(-4)}` : addr;
}

/** Compact USD: 1234567.8 -> "$1.23M", 0.052 -> "$0.052". */
export function fmtUsd(value: number | string | null | undefined): string {
  const n = typeof value === "string" ? Number(value) : value;
  if (n == null || !isFinite(n)) return "-";
  if (n === 0) return "$0";
  if (n < 0.01) return `$${fmtSmall(n)}`;
  if (n < 1000) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${compact(n)}`;
}

/** Small prices with subscript zero count: 0.0000027 -> "0.0(5)27" style. */
export function fmtSmall(n: number): string {
  if (n <= 0) return "0";
  if (n >= 0.01) return n.toFixed(4);
  const s = n.toExponential(3); // e.g. "2.771e-6"
  const [mantissa, expStr] = s.split("e-");
  const zeros = Number(expStr) - 1;
  const digits = mantissa.replace(".", "").slice(0, 4);
  const sub = String(zeros)
    .split("")
    .map((d) => "₀₁₂₃₄₅₆₇₈₉"[Number(d)])
    .join("");
  return `0.0${sub}${digits}`;
}

export function compact(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/** Wei string -> native amount, compact. */
export function fmtWei(wei: string | bigint | undefined, digits = 4): string {
  if (wei == null) return "-";
  const n = Number(wei) / 1e18;
  if (n === 0) return "0";
  if (n < 0.0001) return fmtSmall(n);
  if (n >= 1000) return compact(n);
  return n.toLocaleString("en-US", { maximumFractionDigits: digits });
}

export function fmtNative(wei: string | bigint | undefined, digits = 4): string {
  return `${fmtWei(wei, digits)} ${env.nativeSymbol}`;
}

/** Token base-unit string -> whole tokens, compact. */
export function fmtTokens(raw: string | undefined): string {
  if (!raw) return "-";
  return compact(Number(raw) / 1e18);
}

export function fmtPct(pct: number | null | undefined, signed = true): string {
  if (pct == null || !isFinite(pct)) return "-";
  const sign = signed && pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

export function timeAgo(ts: number): string {
  const s = Math.max(1, Math.floor(Date.now() / 1000 - ts));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

export function explorerTx(hash: string): string | null {
  return env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/tx/${hash}` : null;
}

export function explorerAddr(addr: string): string | null {
  return env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/address/${addr}` : null;
}

/** USD per 1 native token derived from a token summary (priceUsd/priceWei). */
export function usdRateOf(t: { priceUsd: string; priceWei: string }): number {
  const wei = Number(t.priceWei);
  const usd = Number(t.priceUsd);
  if (!isFinite(wei) || !isFinite(usd) || wei <= 0 || usd <= 0) return 0;
  return usd / (wei / 1e18);
}

/** Format a native wei amount as USD using the given native/USD rate. */
export function fmtWeiUsd(wei: string | bigint | undefined, rate: number): string {
  if (wei == null || rate <= 0) return "-";
  return fmtUsd((Number(wei) / 1e18) * rate);
}
