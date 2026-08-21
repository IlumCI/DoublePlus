import { useEffect, useState } from "react";

import type { Lot } from "./client";
import { livePrice } from "./client";

/** Brass gavel mark. */
export function Gavel({ size = 22 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      <rect x="12.2" y="2.4" width="7.4" height="4.6" rx="1.2" transform="rotate(45 12.2 2.4)" fill="#f0b429" />
      <rect x="8" y="6.6" width="7.4" height="4.6" rx="1.2" transform="rotate(45 8 6.6)" fill="#ffd166" />
      <path d="M10.6 10.4 3.6 17.4" stroke="#f0b429" strokeWidth="2.4" strokeLinecap="round" />
      <path d="M13 20.5h8" stroke="#8a7442" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

export const fmtEth = (wei: bigint, digits = 5): string => {
  const v = Number(wei) / 1e18;
  if (v === 0) return "0";
  if (v < 0.00001) return v.toExponential(2);
  return v.toLocaleString("en-US", { maximumFractionDigits: digits });
};

export const fmtTok = (wei: bigint): string => {
  const v = Number(wei) / 1e18;
  if (v >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

export const fmtUsdV = (v: number): string =>
  v >= 1000 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 0 })}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;

export const short = (a: string): string => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** 1s ticker so countdowns and the falling price animate smoothly. */
export function useTick(): number {
  const [, setN] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setN((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, []);
  return Date.now();
}

export function Countdown({ endTime }: { endTime: number }) {
  useTick();
  const left = Math.max(0, endTime - Math.floor(Date.now() / 1000));
  const m = Math.floor(left / 60);
  const s = left % 60;
  return (
    <span className="hm-count">
      <b>{String(m).padStart(2, "0")}</b>:{String(s).padStart(2, "0")}
    </span>
  );
}

/** Live falling price readout (interpolated between polls). */
export function LivePriceEth({ lot }: { lot: Lot }) {
  useTick();
  return <>{fmtEth(livePrice(lot), 9)}</>;
}
