import { useEffect, useMemo, useRef, useState } from "react";
import { CandleType, PolygonType, dispose, init, registerLocale, type Chart as KChart, type KLineData } from "klinecharts";

import { loadPoolTrades, type PoolTrade, type Venture } from "./client";
import { fmtTok, fmtValue, short } from "./ui";
import { env } from "../lib/env";

const INTERVALS = [
  { label: "5m", secs: 300 },
  { label: "15m", secs: 900 },
  { label: "1h", secs: 3600 },
  { label: "4h", secs: 14_400 },
  { label: "1d", secs: 86_400 },
] as const;

const UP = "#a5dbb2";
const DOWN = "#ee8a80";

/** Pool swap log → bars. No indexer, no backend: the chain is the chart. */
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

/** OHLC plus the volume each bucket actually traded, which the bare candle
 *  builder in client.ts does not carry. */
function toBars(trades: PoolTrade[], intervalSecs: number): KLineData[] {
  const out: KLineData[] = [];
  let cur: KLineData | null = null;
  let bucket = -1;
  for (const t of trades) {
    const b = Math.floor(t.ts / intervalSecs) * intervalSecs;
    const px = Number(t.priceWei) / 1e18;
    const vol = Number(t.coinAmount) / 1e18;
    const turnover = Number(t.pairAmount) / 1e18;
    if (!cur || b !== bucket) {
      if (cur) out.push(cur);
      bucket = b;
      cur = { timestamp: b * 1000, open: cur ? cur.close : px, high: px, low: px, close: px, volume: vol, turnover };
    } else {
      cur.volume = (cur.volume ?? 0) + vol;
      cur.turnover = (cur.turnover ?? 0) + turnover;
    }
    cur.high = Math.max(cur.high, px);
    cur.low = Math.min(cur.low, px);
    cur.close = px;
  }
  if (cur) out.push(cur);
  return out;
}

/** Enough significant figures to render a 1e-12 token without collapsing. */
function precisionFor(bars: KLineData[]): number {
  const lows = bars.map((b) => b.low).filter((x) => x > 0);
  if (lows.length === 0) return 8;
  return Math.min(16, Math.max(2, Math.ceil(-Math.log10(Math.min(...lows))) + 2));
}

try {
  registerLocale("en-GB", {
    time: "Time", open: "Open", high: "High", low: "Low", close: "Close", volume: "Volume",
    change: "Change", turnover: "Turnover",
  });
} catch { /* already registered by a previous mount */ }

/** The price panel: candles, volume and moving averages, with a crosshair
 *  tooltip — a trading chart rather than a sketch of one. */
export function PriceChart({ v, trades }: { v: Venture; trades: PoolTrade[] }) {
  const box = useRef<HTMLDivElement>(null);
  const chart = useRef<KChart | null>(null);
  const [interval_, setInterval_] = useState<(typeof INTERVALS)[number]>(INTERVALS[0]);
  const [style, setStyle] = useState<CandleType>(CandleType.CandleSolid);

  const bars = useMemo(() => toBars(trades, interval_.secs), [trades, interval_]);
  const precision = useMemo(() => precisionFor(bars), [bars]);

  useEffect(() => {
    if (!box.current) return;
    const c = init(box.current, { locale: "en-GB" });
    if (!c) return;
    chart.current = c;
    c.setStyles({
      grid: {
        horizontal: { color: "#30304455" },
        vertical: { color: "#30304455" },
      },
      candle: {
        type: style,
        bar: {
          upColor: UP, downColor: DOWN, noChangeColor: "#9490a6",
          upBorderColor: UP, downBorderColor: DOWN, noChangeBorderColor: "#9490a6",
          upWickColor: UP, downWickColor: DOWN, noChangeWickColor: "#9490a6",
        },
        area: { lineColor: UP, lineSize: 2, backgroundColor: [
          { offset: 0, color: "rgba(165, 219, 178, 0.28)" },
          { offset: 1, color: "rgba(165, 219, 178, 0.01)" },
        ] },
        priceMark: {
          high: { color: "#9490a6" }, low: { color: "#9490a6" },
          last: { upColor: UP, downColor: DOWN, noChangeColor: "#9490a6",
            text: { color: "#15151f" } },
        },
        tooltip: {
          text: { color: "#ece4d0", size: 11, family: "var(--mono)" },
          rect: { color: "#1d1d2b", borderColor: "#44445c", borderRadius: 8 },
        },
      },
      indicator: {
        tooltip: { text: { color: "#a6a1b2", size: 11, family: "var(--mono)" } },
        bars: [{ style: PolygonType.Fill, upColor: "rgba(165,219,178,.45)", downColor: "rgba(238,138,128,.45)", noChangeColor: "#44445c" }],
      },
      xAxis: { axisLine: { color: "#303044" }, tickLine: { color: "#303044" }, tickText: { color: "#9490a6", size: 10 } },
      yAxis: { axisLine: { color: "#303044" }, tickLine: { color: "#303044" }, tickText: { color: "#9490a6", size: 10 } },
      separator: { color: "#303044" },
      crosshair: {
        horizontal: { line: { color: "#9490a6" }, text: { backgroundColor: "#44445c", color: "#ece4d0", borderColor: "#44445c" } },
        vertical: { line: { color: "#9490a6" }, text: { backgroundColor: "#44445c", color: "#ece4d0", borderColor: "#44445c" } },
      },
    });
    c.createIndicator("MA", false, { id: "candle_pane" });
    c.createIndicator("VOL", false, { height: 62 });
    return () => { dispose(box.current!); chart.current = null; };
  }, [style]);

  useEffect(() => {
    const c = chart.current;
    if (!c) return;
    c.setPriceVolumePrecision(precision, 2);
    c.applyNewData(bars);
    // A young pool has a handful of bars. Left at the default the whole series
    // hugs the right edge as a lone toothpick, so widen the bars and push the
    // series inward until there is enough history to fill the pane.
    const w = box.current?.clientWidth ?? 0;
    if (w > 0 && bars.length > 0) {
      const sparse = bars.length < 24;
      c.setBarSpace(sparse ? Math.max(8, Math.min(28, w / 28)) : 8);
      c.setOffsetRightDistance(sparse ? Math.max(60, w * 0.38) : 60);
    }
  }, [bars, precision]);

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
          <button className={style === CandleType.Area ? "on" : ""} title="Switch chart style"
            onClick={() => setStyle(style === CandleType.Area ? CandleType.CandleSolid : CandleType.Area)}>
            {style === CandleType.Area ? "line" : "candles"}
          </button>
        </span>
      </div>
      <div className="dp-pbody" style={{ padding: 0, position: "relative" }}>
        {/* The container is always mounted: klinecharts binds to the node on
            mount, and trades arrive a moment later. */}
        <div ref={box} style={{ height: 320 }} />
        {bars.length === 0 && (
          <p className="dp-agate" style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center" }}>
            No trades yet — the chart draws itself from the pool's swap log.
          </p>
        )}
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
              <td>{fmtValue(t.pairAmount)}</td>
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
