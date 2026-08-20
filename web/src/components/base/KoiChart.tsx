import { useEffect, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode, LineStyle, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import type { Address } from "viem";
import type { CandleInterval } from "@launchpad/sdk";

import { client } from "../../lib/client";

// Timeframe pills, matching the reference chart controls.
const TFS: { label: string; interval: CandleInterval }[] = [
  { label: "1m", interval: "1m" },
  { label: "5m", interval: "5m" },
  { label: "15m", interval: "15m" },
  { label: "1h", interval: "1h" },
  { label: "4h", interval: "4h" },
  { label: "1d", interval: "1d" },
];

const UP = "#4ade80";
const DOWN = "#f87171";
const UP_VOL = "rgba(74,222,128,.35)";
const DOWN_VOL = "rgba(248,113,113,.35)";

// Compact axis/crosshair labels: "$24.5K", "$1.2M", or a few sig-figs for tiny
// prices — so the scale reads like the reference, not raw decimals.
const fmtAxis = (v: number) => {
  if (!isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (a >= 1e6) return `$${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  if (a >= 1) return `$${v.toFixed(2)}`;
  if (a === 0) return "$0";
  return `$${v.toPrecision(3)}`;
};
const fmtVol = (v: number) => {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

type Raw = { time: number; open: number; high: number; low: number; close: number; volume: number };

/**
 * koi.fun price chart — a lightweight-charts view fed by our on-chain candles,
 * styled and featured to the reference: green/red candles (or a line), a volume
 * histogram docked at the bottom, the last-price line + label, a faint symbol
 * watermark, timeframe pills, a candle/line toggle and an MCap/Price switch.
 */
export function KoiChart({ token, symbol }: { token: Address; symbol: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | ISeriesApi<"Line"> | null>(null);
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const rawRef = useRef<Raw[]>([]);
  const scaleRef = useRef(1);

  const [tf, setTf] = useState<CandleInterval>("1h");
  const [type, setType] = useState<"candles" | "line">("candles");
  const [denom, setDenom] = useState<"mcap" | "price">("mcap");
  const [empty, setEmpty] = useState(false);

  // Build the chart shell once, with the volume scale docked to the bottom.
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a1a1aa", fontFamily: "Inter, sans-serif", fontSize: 11, attributionLogo: false },
      grid: { vertLines: { color: "rgba(39,39,42,.45)" }, horzLines: { color: "rgba(39,39,42,.45)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#3f3f46", width: 1, style: LineStyle.Dashed, labelBackgroundColor: "#27272a" }, horzLine: { color: "#3f3f46", labelBackgroundColor: "#27272a" } },
      rightPriceScale: { borderColor: "#27272a", scaleMargins: { top: 0.1, bottom: 0.26 } },
      timeScale: { borderColor: "#27272a", timeVisible: true, secondsVisible: false },
      watermark: { visible: true, text: `$${symbol}`, color: "rgba(161,161,170,.06)", fontSize: 46, fontFamily: "Inter Tight, sans-serif", horzAlign: "center", vertAlign: "center" },
      autoSize: true,
    });
    chartRef.current = chart;
    return () => { chart.remove(); chartRef.current = null; priceRef.current = null; volRef.current = null; };
  }, [symbol]);

  // Render the current data into the price + volume series.
  const draw = () => {
    const chart = chartRef.current;
    if (!chart) return;
    priceRef.current && chart.removeSeries(priceRef.current);
    volRef.current && chart.removeSeries(volRef.current);
    priceRef.current = null;
    volRef.current = null;

    const k = denom === "mcap" ? scaleRef.current : 1;
    const bars = rawRef.current.map((c) => ({ time: c.time as UTCTimestamp, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k, volume: c.volume }));
    setEmpty(bars.length === 0);

    const fmt = { type: "custom" as const, formatter: fmtAxis, minMove: denom === "mcap" ? 0.01 : 1e-9 };
    if (type === "candles") {
      const s = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat: fmt, priceLineColor: "#3f3f46", priceLineStyle: LineStyle.Dashed });
      s.setData(bars.map((b) => ({ time: b.time, open: b.open, high: b.high, low: b.low, close: b.close })));
      priceRef.current = s;
    } else {
      const s = chart.addLineSeries({ color: "#ec4899", lineWidth: 2, priceFormat: fmt, lastValueVisible: true, priceLineVisible: true, priceLineColor: "#3f3f46", priceLineStyle: LineStyle.Dashed, crosshairMarkerBorderColor: "#ec4899" });
      s.setData(bars.map((b) => ({ time: b.time, value: b.close })));
      priceRef.current = s;
    }

    const vol = chart.addHistogramSeries({ priceFormat: { type: "custom", formatter: fmtVol, minMove: 0.01 }, priceScaleId: "vol" });
    vol.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
    vol.setData(bars.map((b) => ({ time: b.time, value: b.volume, color: b.close >= b.open ? UP_VOL : DOWN_VOL })));
    volRef.current = vol;

    chart.timeScale().fitContent();
  };

  // Load candles + wire realtime when token / timeframe changes.
  useEffect(() => {
    if (!chartRef.current) return;
    let live = true;
    let unsub: (() => void) | undefined;
    (async () => {
      const scale = (await (client as any).mcapScale(token).catch(() => 1)) || 1;
      const raw = await (client as any).getCandles(token, tf, { limit: 5000 }).catch(() => []);
      if (!live) return;
      scaleRef.current = scale;
      rawRef.current = (raw as any[])
        .map((c) => ({ time: Number(c.time), open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close), volume: Number(c.volume) }))
        .filter((c) => isFinite(c.open) && c.time)
        .sort((a, b) => a.time - b.time);
      draw();
      unsub = (client as any).subscribeToCandles?.(token, tf, ({ candle }: any) => {
        const c: Raw = { time: Number(candle.time), open: Number(candle.open), high: Number(candle.high), low: Number(candle.low), close: Number(candle.close), volume: Number(candle.volume) };
        const arr = rawRef.current;
        if (arr.length && arr[arr.length - 1].time === c.time) arr[arr.length - 1] = c; else arr.push(c);
        const k = denom === "mcap" ? scaleRef.current : 1;
        if (type === "candles") (priceRef.current as ISeriesApi<"Candlestick">)?.update({ time: c.time as UTCTimestamp, open: c.open * k, high: c.high * k, low: c.low * k, close: c.close * k });
        else (priceRef.current as ISeriesApi<"Line">)?.update({ time: c.time as UTCTimestamp, value: c.close * k });
        volRef.current?.update({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? UP_VOL : DOWN_VOL });
      });
    })();
    return () => { live = false; unsub?.(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, tf]);

  // Redraw (no refetch) when the series type or MCap/Price denomination flips.
  useEffect(() => { draw(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [type, denom]);

  return (
    <div className="kf-chart">
      <div className="kf-chart-bar">
        <div className="kf-chart-tfs">
          {TFS.map((t) => (
            <button key={t.interval} className={tf === t.interval ? "on" : ""} onClick={() => setTf(t.interval)}>{t.label}</button>
          ))}
        </div>
        <div className="kf-chart-tools">
          <div className="kf-chart-denom">
            <button className={denom === "mcap" ? "on" : ""} onClick={() => setDenom("mcap")}>MCap</button>
            <button className={denom === "price" ? "on" : ""} onClick={() => setDenom("price")}>Price</button>
          </div>
          <div className="kf-chart-type">
            <button className={type === "candles" ? "on" : ""} onClick={() => setType("candles")} aria-label="Candlesticks">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 4v3M7 14v6M6 7h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM17 3v5M17 15v6M16 8h2a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h-2a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /></svg>
            </button>
            <button className={type === "line" ? "on" : ""} onClick={() => setType("line")} aria-label="Line">
              <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-6 4 3 6-8" /></svg>
            </button>
          </div>
        </div>
      </div>
      <div className="kf-chart-canvas" ref={box}>
        {empty ? <div className="kf-chart-empty">No trades yet — the chart fills in as {symbol} trades.</div> : null}
      </div>
    </div>
  );
}
