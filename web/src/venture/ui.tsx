import { useEffect, useState } from "react";

/** Flag-on-a-block mark: a raised founder flag. */
export function Flag({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path d="M6 21V4" stroke="var(--v-green, #2fd575)" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M6.8 4.6c2.6-1.7 4.9-1.7 7.4 0 2 1.3 3.6 1.4 5.4.5v7c-1.8.9-3.4.8-5.4-.5-2.5-1.7-4.8-1.7-7.4 0z" fill="var(--v-green, #2fd575)" opacity="0.9" />
      <path d="M3.5 21h9" stroke="var(--v-ink-3, #6b7a90)" strokeWidth="2" strokeLinecap="round" />
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
  v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

export const pct = (num: bigint, den: bigint): number =>
  den === 0n ? 0 : Math.min(100, Number((num * 10_000n) / den) / 100);

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
    <span className="vn-count">
      {d > 0 ? <><b>{d}</b>d <b>{String(h).padStart(2, "0")}</b>h {String(m).padStart(2, "0")}m</>
        : <><b>{String(h).padStart(2, "0")}</b>:{String(m).padStart(2, "0")}:{String(s).padStart(2, "0")}</>}
    </span>
  );
}
