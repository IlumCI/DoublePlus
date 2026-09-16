import { useEffect, useRef, useState } from "react";
import { ColorType, CrosshairMode, createChart, type UTCTimestamp } from "lightweight-charts";

import { loadPoolTrades, toCandles, type PoolTrade, type Venture } from "./client";
import { fmtEth, fmtTok, short } from "./ui";
import { env } from "../lib/env";

const INTERVALS = [
  { label: "5m", secs: 300 },
  { label: "1h", secs: 3600 },
  { label: "1d", secs: 86_400 },
] as const;

/** Post-graduation market panel: candles from the pool's own swap log plus
 *  the raw trade tape. No indexer, no backend — the chain is the chart. */
export function MarketPanel({ v }: { v: Venture }) {
  const box = useRef<HTMLDivElement>(null);
  const [trades, setTrades] = useState<PoolTrade[]>([]);
  const [interval_, setInterval_] = useState<(typeof INTERVALS)[number]>(INTERVALS[0]);

  useEffect(() => {
    let live = true;
    const refresh = () => loadPoolTrades(v).then((t) => live && setTrades(t)).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => { live = false; clearInterval(id); };
  }, [v.address]);

  useEffect(() => {
    if (!box.current) return;
    const candles = toCandles(trades, interval_.secs);
    if (candles.length === 0) return;
    const chart = createChart(box.current, {
      height: 260,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#6b7a90", fontSize: 11 },
      grid: { vertLines: { color: "#1f2c4733" }, horzLines: { color: "#1f2c4733" } },
      rightPriceScale: { borderColor: "#1f2c47" },
      timeScale: { borderColor: "#1f2c47", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: "#2fd575", downColor: "#ff6b6b", borderUpColor: "#2fd575", borderDownColor: "#ff6b6b",
      wickUpColor: "#2fd575", wickDownColor: "#ff6b6b",
      priceFormat: { type: "price", precision: 10, minMove: 1e-10 },
    });
    series.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [trades, interval_]);

  return (
    <div className="vn-card mt-5 p-5">
      <div className="flex items-center justify-between">
        <p className="vn-eyebrow">price · ETH per ${v.symbol}</p>
        <div className="vn-seg" style={{ width: 150 }}>
          {INTERVALS.map((iv) => (
            <button key={iv.label} className={interval_.label === iv.label ? "on" : ""} onClick={() => setInterval_(iv)}>
              {iv.label}
            </button>
          ))}
        </div>
      </div>
      {trades.length === 0 ? (
        <p className="py-10 text-center text-[13px]" style={{ color: "var(--v-ink-3)" }}>
          No trades yet — the chart draws itself from the pool's swap log.
        </p>
      ) : (
        <div ref={box} className="mt-3" style={{ height: 260 }} />
      )}

      {trades.length > 0 && (
        <>
          <p className="vn-eyebrow mt-5 mb-1">trade tape</p>
          <div className="vn-rows">
            {trades.slice(-12).reverse().map((t) => (
              <div className="r" key={t.txHash + t.blockNumber}>
                <span style={{ color: t.isBuy ? "var(--v-green-2)" : "var(--v-red)", fontWeight: 700 }}>
                  {t.isBuy ? "BUY" : "SELL"}
                </span>
                <span className="vn-num">{fmtTok(t.coinAmount)} ${v.symbol}</span>
                <span className="vn-num" style={{ color: "var(--v-ink-2)" }}>{fmtEth(t.pairAmount, 6)} ETH</span>
                {env.explorerUrl
                  ? <a className="vn-num" style={{ color: "var(--v-ink-3)" }} href={`${env.explorerUrl}/tx/${t.txHash}`} target="_blank" rel="noreferrer">{short(t.txHash)}</a>
                  : <span className="vn-num" style={{ color: "var(--v-ink-3)" }}>{short(t.txHash)}</span>}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
