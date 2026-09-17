import { useEffect, useRef, useState } from "react";
import { ColorType, CrosshairMode, PriceScaleMode, createChart, type UTCTimestamp } from "lightweight-charts";

import { loadPoolTrades, toCandles, type PoolTrade, type Venture } from "./client";
import { fmtEth, fmtTok, short } from "./ui";
import { env } from "../lib/env";

const INTERVALS = [
  { label: "5m", secs: 300 },
  { label: "1h", secs: 3600 },
  { label: "1d", secs: 86_400 },
] as const;

const UP = "#a5dbb2";
const DOWN = "#ee8a80";

/** Pool swap log → candles. No indexer, no backend: the chain is the chart. */
export function usePoolTrades(v: Venture): PoolTrade[] {
  const [trades, setTrades] = useState<PoolTrade[]>([]);
  useEffect(() => {
    if (v.phase !== "graduated") return;
    let live = true;
    const refresh = () => loadPoolTrades(v).then((t) => live && setTrades(t)).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => { live = false; clearInterval(id); };
  }, [v.address, v.phase]);
  return trades;
}

/** The chart panel that owns the top-left of a graduated token page. */
export function PriceChart({ v, trades }: { v: Venture; trades: PoolTrade[] }) {
  const box = useRef<HTMLDivElement>(null);
  const [interval_, setInterval_] = useState<(typeof INTERVALS)[number]>(INTERVALS[0]);

  useEffect(() => {
    if (!box.current) return;
    const candles = toCandles(trades, interval_.secs);
    if (candles.length === 0) return;

    // Curve tokens price in the 1e-12 range and can move orders of magnitude in
    // a day, so the scale has to be derived from the data, not assumed: enough
    // decimals to render the smallest tick, and a log scale once the range is
    // wide enough that a linear one would draw a single block.
    const lows = candles.map((c) => c.low).filter((x) => x > 0);
    const highs = candles.map((c) => c.high).filter((x) => x > 0);
    const minLow = lows.length > 0 ? Math.min(...lows) : 1;
    const maxHigh = highs.length > 0 ? Math.max(...highs) : 1;
    const precision = Math.min(16, Math.max(2, Math.ceil(-Math.log10(minLow)) + 2));
    const wideRange = maxHigh / minLow > 50;
    const chart = createChart(box.current, {
      height: 260,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: "#6f6c80", fontSize: 11 },
      grid: { vertLines: { color: "#30304455" }, horzLines: { color: "#30304455" } },
      rightPriceScale: { borderColor: "#303044", mode: wideRange ? PriceScaleMode.Logarithmic : PriceScaleMode.Normal },
      timeScale: { borderColor: "#303044", timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet },
      autoSize: true,
    });
    const series = chart.addCandlestickSeries({
      upColor: UP, downColor: DOWN, borderUpColor: UP, borderDownColor: DOWN,
      wickUpColor: UP, wickDownColor: DOWN,
      priceFormat: { type: "price", precision, minMove: 10 ** -precision },
    });
    series.setData(candles.map((c) => ({ ...c, time: c.time as UTCTimestamp })));
    chart.timeScale().fitContent();
    return () => chart.remove();
  }, [trades, interval_]);

  return (
    <div className="dp-panel dp-chartpanel">
      <div className="dp-phead">
        <span>${v.symbol} / ETH</span>
        <span className="dp-tfchips">
          {INTERVALS.map((iv) => (
            <button key={iv.label} className={interval_.label === iv.label ? "on" : ""} onClick={() => setInterval_(iv)}>
              {iv.label}
            </button>
          ))}
        </span>
      </div>
      <div className="dp-pbody">
        {trades.length === 0
          ? <p className="dp-agate" style={{ padding: "90px 0", textAlign: "center" }}>No trades yet — the chart draws itself from the pool's swap log.</p>
          : <div ref={box} style={{ height: 260 }} />}
      </div>
    </div>
  );
}

/** The raw tape, for the Trades tab. */
export function TradeTape({ v, trades }: { v: Venture; trades: PoolTrade[] }) {
  if (trades.length === 0) return <p className="dp-agate">No trades yet.</p>;
  return (
    <div className="dp-blotter" style={{ maxHeight: "none" }}>
      <table>
        <tbody>
          {trades.slice(-40).reverse().map((t) => (
            <tr key={t.txHash + t.blockNumber}>
              <td className={t.isBuy ? "dp-b" : "dp-s"}>{t.isBuy ? "BUY" : "SELL"}</td>
              <td>{fmtTok(t.coinAmount)} ${v.symbol}</td>
              <td>{fmtEth(t.pairAmount, 6)} ETH</td>
              <td style={{ textAlign: "right" }}>
                {env.explorerUrl
                  ? <a href={`${env.explorerUrl}/tx/${t.txHash}`} target="_blank" rel="noreferrer">{short(t.txHash)}</a>
                  : short(t.txHash)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
