import { useId, useMemo, useRef, useState } from "react";
import { fmtUsd } from "../lib/format";

function smoothPath(pts: Array<[number, number]>): string {
  if (pts.length < 2) return "";
  let d = `M ${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const c1x = p1[0] + (p2[0] - p0[0]) / 6;
    const c1y = p1[1] + (p2[1] - p0[1]) / 6;
    const c2x = p2[0] - (p3[0] - p1[0]) / 6;
    const c2y = p2[1] - (p3[1] - p1[1]) / 6;
    d += ` C ${c1x} ${c1y}, ${c2x} ${c2y}, ${p2[0]} ${p2[1]}`;
  }
  return d;
}

function toPoints(data: number[], w: number, h: number, pad: number): Array<[number, number]> {
  const min = Math.min(...data);
  const max = Math.max(...data);
  const span = max - min || 1;
  return data.map((v, i) => [
    pad + (i / (data.length - 1)) * (w - pad * 2),
    pad + (1 - (v - min) / span) * (h - pad * 2),
  ]);
}

export function Sparkline({
  data,
  width = 120,
  height = 40,
  positive = true,
}: {
  data: number[];
  width?: number;
  height?: number;
  positive?: boolean;
}) {
  const id = useId();
  const color = positive ? "var(--up)" : "var(--down)";
  const pts = useMemo(() => toPoints(data, width, height, 2), [data, width, height]);
  const line = useMemo(() => smoothPath(pts), [pts]);
  const area = `${line} L ${width - 2} ${height} L 2 ${height} Z`;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <defs>
        <linearGradient id={`sf-${id}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.22" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#sf-${id})`} />
      <path d={line} fill="none" stroke={color} strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function AreaChart({
  data,
  height = 260,
  formatValue = (v: number) => fmtUsd(v),
  labels,
}: {
  data: number[];
  height?: number;
  formatValue?: (v: number) => string;
  labels?: string[];
}) {
  const id = useId();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const W = 800;
  const pad = 8;

  const pts = useMemo(() => toPoints(data, W, height, pad), [data, height]);
  const line = useMemo(() => smoothPath(pts), [pts]);
  const area = `${line} L ${W - pad} ${height} L ${pad} ${height} Z`;
  const rising = data[data.length - 1] >= data[0];
  const color = rising ? "#22C55E" : "#EF4444";

  const onMove = (e: React.MouseEvent) => {
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((x - pad) / (W - pad * 2)) * (data.length - 1));
    setHover(Math.max(0, Math.min(data.length - 1, i)));
  };

  const hoverPt = hover !== null ? pts[hover] : null;

  return (
    <div
      ref={wrapRef}
      style={{ position: "relative", width: "100%" }}
      onMouseMove={onMove}
      onMouseLeave={() => setHover(null)}
    >
      <svg
        viewBox={`0 0 ${W} ${height}`}
        style={{ width: "100%", height: "auto", display: "block" }}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={`af-${id}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.24" />
            <stop offset="100%" stopColor={color} stopOpacity="0" />
          </linearGradient>
        </defs>
        <path d={area} fill={`url(#af-${id})`} />
        <path
          d={line}
          fill="none"
          stroke={color}
          strokeWidth="2.2"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
        {hoverPt && (
          <>
            <line
              x1={hoverPt[0]}
              y1={0}
              x2={hoverPt[0]}
              y2={height}
              stroke="rgba(255,255,255,0.18)"
              strokeWidth="1"
              vectorEffect="non-scaling-stroke"
              strokeDasharray="3 4"
            />
            <circle cx={hoverPt[0]} cy={hoverPt[1]} r="5" fill={color} stroke="#080A0F" strokeWidth="2.5" />
          </>
        )}
      </svg>
      {hover !== null && hoverPt && (
        <div
          className="chart-tip"
          style={{
            left: `${(hoverPt[0] / W) * 100}%`,
            top: `${(hoverPt[1] / height) * 100}%`,
          }}
        >
          <div style={{ fontWeight: 600 }}>{formatValue(data[hover])}</div>
          {labels?.[hover] && <div className="faint" style={{ fontSize: "0.72rem" }}>{labels[hover]}</div>}
        </div>
      )}
    </div>
  );
}
