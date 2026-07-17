import { useEffect, useMemo, useRef, useState } from "react";
import type { Address, Candle, CandleInterval } from "@launchpad/sdk";
import { CANDLE_INTERVALS, INTERVAL_SECONDS } from "@launchpad/sdk";

import { client } from "../lib/client";
import { v4Client } from "../lib/client";

const UP = "#0EA54E";
const DOWN = "#E5484D";
const AXIS = "#9aa0a8";
const GRID = "rgba(255, 255, 255, 0.06)";

const intervalLabels: Record<CandleInterval, string> = {
  "1m": "1m",
  "5m": "5m",
  "15m": "15m",
  "30m": "30m",
  "1h": "1H",
  "4h": "4H",
  "1d": "1D",
  "1w": "1W",
};

function fmtMcap(v: number): string {
  if (!isFinite(v) || v <= 0) return "$0";
  if (v >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (v >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (v >= 100_000) return `$${(v / 1e3).toFixed(0)}K`;
  if (v >= 1_000) return `$${(v / 1e3).toFixed(1)}K`;
  if (v >= 1) return `$${v.toFixed(2)}`;
  return `$${v.toPrecision(2)}`;
}

function fmtTime(sec: number, interval: CandleInterval): string {
  const d = new Date(sec * 1000);
  const intraday = INTERVAL_SECONDS[interval] < 86400;
  if (intraday) {
    return d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

/** USD market cap per unit of WETH-per-token price: WETH/USD x whole supply. */
async function fetchMcapScale(token: Address): Promise<number> {
  try {
    return await v4Client.mcapScale(token);
  } catch {
    return 1;
  }
}

/**
 * Custom SVG price-line chart. Renders the market cap over time as a single
 * line with a heatmap-style glow fill beneath it, a live current-price line,
 * a hover crosshair and a light price/time grid. No third-party charting
 * engine — the series loads over REST and the active bucket updates in place
 * from the candle stream.
 */
export function PriceChart({ token }: { token: Address }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const [interval, setInterval] = useState<CandleInterval>("1m");
  const [candles, setCandles] = useState<Candle[]>([]);
  const [scale, setScale] = useState(1);
  const [dims, setDims] = useState({ w: 0, h: 0 });
  const [hover, setHover] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  const gid = useMemo(() => `heat-${token.slice(2, 8)}`, [token]);

  // Track container size.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0].contentRect;
      setDims({ w: r.width, h: r.height });
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Data load + live stream per token/interval.
  useEffect(() => {
    let cancelled = false;
    setCandles([]);
    setLoaded(false);
    const load = async () => {
      const s = await fetchMcapScale(token);
      if (cancelled) return;
      setScale(s);
      const c = await client.getCandles(token, interval, { limit: 300 });
      if (cancelled) return;
      setCandles(c);
      setLoaded(true);
    };
    load().catch(() => setLoaded(true));

    const unsub = client.subscribeToCandles(token, interval, ({ candle }) => {
      if (cancelled) return;
      setCandles((prev) => {
        if (prev.length === 0) return [candle];
        const last = prev[prev.length - 1];
        if (last.time === candle.time) {
          const next = prev.slice();
          next[next.length - 1] = candle;
          return next;
        }
        if (candle.time > last.time) return [...prev, candle].slice(-300);
        return prev;
      });
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, [token, interval]);

  const series = useMemo(
    () => candles.map((c) => ({ t: c.time, v: Number(c.close) * scale })).filter((p) => p.v > 0),
    [candles, scale],
  );

  const geo = useMemo(() => {
    const { w, h } = dims;
    const padR = 58;
    const padB = 20;
    const padT = 10;
    const padL = 8;
    const plotW = Math.max(0, w - padL - padR);
    const plotH = Math.max(0, h - padT - padB);
    if (series.length < 2 || plotW <= 0 || plotH <= 0) return null;

    let min = Infinity;
    let max = -Infinity;
    for (const p of series) {
      if (p.v < min) min = p.v;
      if (p.v > max) max = p.v;
    }
    const pad = (max - min) * 0.12 || max * 0.12 || 1;
    min -= pad;
    max += pad;
    const span = max - min || 1;

    const n = series.length;
    const x = (i: number) => padL + (plotW * i) / (n - 1);
    const y = (v: number) => padT + plotH * (1 - (v - min) / span);

    const pts = series.map((p, i) => [x(i), y(p.v)] as const);
    const line = pts.map(([px, py], i) => `${i === 0 ? "M" : "L"}${px.toFixed(1)} ${py.toFixed(1)}`).join(" ");
    const area = `${line} L${(padL + plotW).toFixed(1)} ${(padT + plotH).toFixed(1)} L${padL.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

    // Horizontal price gridlines.
    const ticks: { y: number; label: string }[] = [];
    const steps = 4;
    for (let i = 0; i <= steps; i++) {
      const v = min + (span * i) / steps;
      ticks.push({ y: y(v), label: fmtMcap(v) });
    }

    return { padL, padR, padT, padB, plotW, plotH, x, y, pts, line, area, min, max, ticks, n };
  }, [dims, series]);

  const up = series.length >= 2 ? series[series.length - 1].v >= series[0].v : true;
  const color = up ? UP : DOWN;
  const last = series.length ? series[series.length - 1] : null;

  const onMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!geo) return;
    const rect = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
    const px = e.clientX - rect.left;
    const rel = (px - geo.padL) / geo.plotW;
    const idx = Math.round(rel * (geo.n - 1));
    setHover(Math.max(0, Math.min(geo.n - 1, idx)));
  };

  return (
    <div className="flex h-full flex-col">
      {/* Toolbar */}
      <div className="flex items-center gap-1 overflow-x-auto border-b border-edge px-3 py-2 no-scrollbar">
        {CANDLE_INTERVALS.map((iv) => (
          <button
            key={iv}
            onClick={() => setInterval(iv)}
            className={`shrink-0 rounded-md px-2.5 py-1 text-xs font-semibold transition-colors ${
              interval === iv ? "bg-accent text-ink" : "text-ink-3 hover:text-ink"
            }`}
          >
            {intervalLabels[iv]}
          </button>
        ))}
      </div>

      {/* Plot */}
      <div ref={wrapRef} className="relative min-h-0 flex-1">
        {geo && last ? (
          <svg
            width={dims.w}
            height={dims.h}
            className="absolute inset-0 touch-pan-y"
            onPointerMove={onMove}
            onPointerLeave={() => setHover(null)}
            role="img"
            aria-label="Market cap chart"
          >
            <defs>
              <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity="0.22" />
                <stop offset="55%" stopColor={color} stopOpacity="0.07" />
                <stop offset="100%" stopColor={color} stopOpacity="0" />
              </linearGradient>
            </defs>

            {/* Grid + right-axis price labels */}
            {geo.ticks.map((tk, i) => (
              <g key={i}>
                <line x1={geo.padL} y1={tk.y} x2={geo.padL + geo.plotW} y2={tk.y} stroke={GRID} strokeWidth="1" />
                <text
                  x={geo.padL + geo.plotW + 6}
                  y={tk.y + 3}
                  fill={AXIS}
                  fontSize="10"
                  fontFamily="'JetBrains Mono', ui-monospace, monospace"
                >
                  {tk.label}
                </text>
              </g>
            ))}

            {/* Heatmap fill + line */}
            <path d={geo.area} fill={`url(#${gid})`} />
            <path
              d={geo.line}
              fill="none"
              stroke={color}
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />

            {/* Current-price line */}
            <line
              x1={geo.padL}
              y1={geo.y(last.v)}
              x2={geo.padL + geo.plotW}
              y2={geo.y(last.v)}
              stroke={color}
              strokeWidth="1"
              strokeDasharray="3 3"
              opacity="0.5"
            />
            <g>
              <rect
                x={geo.padL + geo.plotW + 2}
                y={geo.y(last.v) - 8}
                width={geo.padR - 4}
                height="16"
                rx="3"
                fill={color}
              />
              <text
                x={geo.padL + geo.plotW + 2 + (geo.padR - 4) / 2}
                y={geo.y(last.v) + 3}
                fill="#ffffff"
                fontSize="10"
                fontWeight="700"
                textAnchor="middle"
                fontFamily="'JetBrains Mono', ui-monospace, monospace"
              >
                {fmtMcap(last.v)}
              </text>
            </g>

            {/* Live endpoint dot */}
            <circle cx={geo.pts[geo.n - 1][0]} cy={geo.pts[geo.n - 1][1]} r="3" fill={color} />

            {/* Crosshair */}
            {hover != null && geo.pts[hover] ? (
              <g>
                <line
                  x1={geo.pts[hover][0]}
                  y1={geo.padT}
                  x2={geo.pts[hover][0]}
                  y2={geo.padT + geo.plotH}
                  stroke={AXIS}
                  strokeWidth="1"
                  strokeDasharray="3 3"
                  opacity="0.5"
                />
                <circle cx={geo.pts[hover][0]} cy={geo.pts[hover][1]} r="3.5" fill={color} stroke="#ffffff" strokeWidth="1.5" />
                <HoverTag
                  x={geo.pts[hover][0]}
                  plotL={geo.padL}
                  plotR={geo.padL + geo.plotW}
                  top={geo.padT}
                  value={fmtMcap(series[hover].v)}
                  time={fmtTime(series[hover].t, interval)}
                />
              </g>
            ) : null}
          </svg>
        ) : (
          <div className="absolute inset-0 grid place-items-center">
            <p className="text-sm text-ink-3">
              {loaded ? "No trades yet. The first trade starts the chart." : "Loading market…"}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}

function HoverTag({
  x,
  plotL,
  plotR,
  top,
  value,
  time,
}: {
  x: number;
  plotL: number;
  plotR: number;
  top: number;
  value: string;
  time: string;
}) {
  const w = 92;
  const h = 30;
  let tx = x - w / 2;
  if (tx < plotL) tx = plotL;
  if (tx + w > plotR) tx = plotR - w;
  return (
    <g>
      <rect x={tx} y={top + 2} width={w} height={h} rx="5" fill="#111111" stroke="#111111" />
      <text x={tx + w / 2} y={top + 15} fill="#ffffff" fontSize="11" fontWeight="700" textAnchor="middle" fontFamily="'JetBrains Mono', ui-monospace, monospace">
        {value}
      </text>
      <text x={tx + w / 2} y={top + 26} fill="#b8bcc4" fontSize="9" textAnchor="middle" fontFamily="'JetBrains Mono', ui-monospace, monospace">
        {time}
      </text>
    </g>
  );
}
