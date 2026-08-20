import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "@launchpad/sdk";

import { client } from "../lib/client";

const UP = "#0EA54E";
const DOWN = "#E5484D";

/**
 * Minimal line sparkline of the market since launch, drawn from real 15m
 * candle closes with a soft area fill. Presentational only; no axes, no
 * interaction. Colored by the direction of the window. Loads lazily and
 * refreshes on an interval, so the strip tracks the market without reloads.
 */
export function MiniChart({
  token,
  width = 116,
  height = 40,
}: {
  token: Address;
  width?: number;
  height?: number;
}) {
  const { data: candles } = useQuery({
    queryKey: ["mini-candles", token],
    queryFn: () => client.getCandles(token, "15m", { limit: 32 }),
    refetchInterval: 30_000,
    staleTime: 20_000,
  });

  const gid = useMemo(() => `spark-${token.slice(2, 8)}`, [token]);

  const closes = (candles ?? []).map((c) => Number(c.close)).filter((n) => n > 0);

  if (closes.length < 2) {
    return (
      <svg width={width} height={height} aria-hidden className="block">
        <line
          x1="0"
          y1={height / 2}
          x2={width}
          y2={height / 2}
          stroke="#333842"
          strokeWidth="1.5"
          strokeDasharray="2 5"
          strokeLinecap="round"
        />
      </svg>
    );
  }

  const min = Math.min(...closes);
  const max = Math.max(...closes);
  const span = max - min || max || 1;
  const n = closes.length;
  const dx = width / (n - 1);
  const pad = 3;
  const y = (v: number) => pad + (height - pad * 2) * (1 - (v - min) / span);

  const pts = closes.map((v, i) => [i * dx, y(v)] as const);
  const line = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;
  const up = closes[n - 1] >= closes[0];
  const color = up ? UP : DOWN;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} className="block" role="img" aria-label="Price trend">
      <defs>
        <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.16" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${gid})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx={pts[n - 1][0]} cy={pts[n - 1][1]} r="2.25" fill={color} />
    </svg>
  );
}
