import { useEffect, useMemo, useRef, useState } from "react";
import { createChart, ColorType, CrosshairMode, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
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

type Bar = { time: UTCTimestamp; open: number; high: number; low: number; close: number };

/**
 * koi.fun price chart — a clean lightweight-charts candlestick/line view fed by
 * our on-chain candles, styled to the reference: green/red candles, a muted
 * grid on a transparent ground, timeframe pills and a candle/line toggle. The
 * on-chain price is scaled to market cap, like the discovery figures.
 */
export function KoiChart({ token, symbol }: { token: Address; symbol: string }) {
  const box = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const [tf, setTf] = useState<CandleInterval>("1h");
  const [type, setType] = useState<"candles" | "line">("candles");
  const [empty, setEmpty] = useState(false);

  // Build the chart once.
  useEffect(() => {
    if (!box.current) return;
    const chart = createChart(box.current, {
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#a1a1aa", fontFamily: "Inter, sans-serif", fontSize: 11 },
      grid: { vertLines: { color: "rgba(39,39,42,.5)" }, horzLines: { color: "rgba(39,39,42,.5)" } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: "#3f3f46", labelBackgroundColor: "#27272a" }, horzLine: { color: "#3f3f46", labelBackgroundColor: "#27272a" } },
      rightPriceScale: { borderColor: "#27272a" },
      timeScale: { borderColor: "#27272a", timeVisible: true, secondsVisible: false },
      autoSize: true,
    });
    chartRef.current = chart;
    const ro = new ResizeObserver(() => chart.applyOptions({}));
    ro.observe(box.current);
    return () => { ro.disconnect(); chart.remove(); chartRef.current = null; candleRef.current = null; lineRef.current = null; };
  }, []);

  // Load candles + wire realtime whenever token / timeframe / type changes.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let live = true;
    let unsub: (() => void) | undefined;

    candleRef.current && chart.removeSeries(candleRef.current);
    lineRef.current && chart.removeSeries(lineRef.current);
    candleRef.current = null;
    lineRef.current = null;

    (async () => {
      const scale = await (client as any).mcapScale(token).catch(() => 1) || 1;
      const raw = await (client as any).getCandles(token, tf, { limit: 5000 }).catch(() => []);
      if (!live) return;
      const bars: Bar[] = (raw as any[])
        .map((c) => ({ time: Number(c.time) as UTCTimestamp, open: Number(c.open) * scale, high: Number(c.high) * scale, low: Number(c.low) * scale, close: Number(c.close) * scale }))
        .filter((b) => isFinite(b.open) && b.time)
        .sort((a, b) => a.time - b.time);
      setEmpty(bars.length === 0);

      if (type === "candles") {
        const s = chart.addCandlestickSeries({ upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, priceFormat: { type: "price", precision: 6, minMove: 0.000001 } });
        s.setData(bars as any);
        candleRef.current = s;
      } else {
        const s = chart.addLineSeries({ color: "#ec4899", lineWidth: 2, priceFormat: { type: "price", precision: 6, minMove: 0.000001 } });
        s.setData(bars.map((b) => ({ time: b.time, value: b.close })) as any);
        lineRef.current = s;
      }
      chart.timeScale().fitContent();

      // Realtime: fold each new candle into the live series.
      unsub = (client as any).subscribeToCandles?.(token, tf, ({ candle }: any) => {
        const b = { time: Number(candle.time) as UTCTimestamp, open: Number(candle.open) * scale, high: Number(candle.high) * scale, low: Number(candle.low) * scale, close: Number(candle.close) * scale };
        if (type === "candles") candleRef.current?.update(b as any);
        else lineRef.current?.update({ time: b.time, value: b.close } as any);
      });
    })();

    return () => { live = false; unsub?.(); };
  }, [token, tf, type]);

  const tfBtns = useMemo(() => TFS, []);

  return (
    <div className="kf-chart">
      <div className="kf-chart-bar">
        <div className="kf-chart-tfs">
          {tfBtns.map((t) => (
            <button key={t.interval} className={tf === t.interval ? "on" : ""} onClick={() => setTf(t.interval)}>{t.label}</button>
          ))}
        </div>
        <div className="kf-chart-type">
          <button className={type === "candles" ? "on" : ""} onClick={() => setType("candles")} aria-label="Candlesticks">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M7 4v3M7 14v6M7 7h0a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1H7a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1ZM17 3v5M17 15v6M17 8a1 1 0 0 1 1 1v5a1 1 0 0 1-1 1h0a1 1 0 0 1-1-1V9a1 1 0 0 1 1-1Z" /></svg>
          </button>
          <button className={type === "line" ? "on" : ""} onClick={() => setType("line")} aria-label="Line">
            <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M3 17l5-6 4 3 6-8" /></svg>
          </button>
        </div>
      </div>
      <div className="kf-chart-canvas" ref={box}>
        {empty ? <div className="kf-chart-empty">No trades yet — the chart fills in as {symbol} trades.</div> : null}
      </div>
    </div>
  );
}
