import { useMemo, useState } from "react";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { client } from "../lib/client";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";
import { fmtUsd, shortAddr } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { volUsd } from "../components/market/util";
import { PREVIEW, PREVIEW_ON } from "../lib/base/preview";

const ord = (n: number) => ["th", "st", "nd", "rd"][n % 10 > 3 || (n % 100 >= 11 && n % 100 <= 13) ? 0 : n % 10];

type Mode = "volume" | "launched";
type Period = "24h" | "all";

interface CreatorRow {
  address: string;
  vol24: number;
  volTotal: number;
  launched: number;
  best: string;
}

/**
 * Leaderboard — every creator on basedstonk, ranked by the volume on the coins
 * they launch. The period pills switch between 24h and lifetime volume.
 */
export function BaseLeaderboard() {
  const [mode, setMode] = useState<Mode>("volume");
  const [period, setPeriod] = useState<Period>("24h");
  const [q, setQ] = useState("");
  const { data: byVolume } = useTokens(client, { sort: "volume", limit: 100 });

  const rows = useMemo(() => {
    let list = (byVolume ?? []).filter((t: TokenSummary) => !env.hideTokens && !isHidden(t.address) && !isImpersonator(t));
    if (list.length === 0 && PREVIEW_ON) list = PREVIEW;
    const map = new Map<string, CreatorRow>();
    for (const t of list) {
      const key = t.creator?.toLowerCase() ?? "unknown";
      const r = map.get(key) ?? { address: t.creator, vol24: 0, volTotal: 0, launched: 0, best: t.symbol };
      const v24 = volUsd(t);
      const vTot = (Number(t.volumeTotalWei || "0") / 1e18) * (v24 > 0 && Number(t.volume24hWei || "0") > 0 ? v24 / (Number(t.volume24hWei) / 1e18) : 1);
      r.vol24 += v24;
      r.volTotal += vTot;
      r.launched += 1;
      if (Number(t.marketCapUsd) > 0 && r.best === t.symbol) r.best = t.symbol;
      map.set(key, r);
    }
    let arr = [...map.values()];
    if (q.trim()) arr = arr.filter((r) => r.address?.toLowerCase().includes(q.trim().toLowerCase()));
    const vol = (r: CreatorRow) => (period === "24h" ? r.vol24 : r.volTotal);
    arr.sort((a, b) => (mode === "launched" ? b.launched - a.launched || vol(b) - vol(a) : vol(b) - vol(a) || b.launched - a.launched));
    return arr;
  }, [byVolume, mode, period, q]);

  const podium = rows.slice(0, 3);
  const vol = (r: CreatorRow) => (period === "24h" ? r.vol24 : r.volTotal);

  return (
    <div className="kf kf-page">
      <section className="kf-hero">
        <h1 className="kf-hero-title-xl">Leaderboard</h1>
        <p className="kf-hero-copy">Every creator on {BRAND.name}, ranked by the trading volume of the coins they launch.</p>
        <p className="kf-hero-note">More volume means more rewards streamed to holders — this is who's driving it.</p>
        <div className="kf-pod-scroll">
          {podium.length === 0
            ? [...Array(2)].map((_, i) => <div key={i} className="kf-pod-card" style={{ height: 128 }} />)
            : podium.map((r, i) => (
                <div key={r.address} className="kf-pod-card">
                  <div className="kf-pod-top">
                    <span className="kf-pod-rank">{i + 1}{ord(i + 1)}</span>
                    <span className="kf-pod-name">{shortAddr(r.address)}</span>
                  </div>
                  <div className="kf-pod-stats">
                    <div><div className="k">Volume ({period === "all" ? "all" : period})</div><div className="v">{fmtUsd(vol(r))}</div></div>
                    <div style={{ textAlign: "right" }}><div className="k">Launched</div><div className="v">{r.launched}</div></div>
                  </div>
                </div>
              ))}
        </div>
      </section>

      <div className="kf-lb-tools">
        <label className="kf-input">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by wallet address" />
        </label>
        <div className="kf-pills">
          <button className={`kf-pill ${mode === "volume" ? "on" : ""}`} onClick={() => setMode("volume")}>Volume</button>
          <button className={`kf-pill ${mode === "launched" ? "on" : ""}`} onClick={() => setMode("launched")}>Launched</button>
          <span className="sp" />
          {(["24h", "all"] as Period[]).map((p) => (
            <button key={p} className={`kf-pill ${period === p ? "on" : ""}`} onClick={() => setPeriod(p)}>{p === "all" ? "All" : p}</button>
          ))}
        </div>
      </div>

      <div className="kf-rank-list">
        {rows.slice(0, 50).map((r, i) => (
          <a key={r.address} href={env.explorerUrl ? `${env.explorerUrl.replace(/\/$/, "")}/address/${r.address}` : "#"} target="_blank" rel="noreferrer" className="kf-rank-row">
            <span className="kf-rank-num">{i + 1}</span>
            <span className="kf-ava" style={{ width: 36, height: 36, background: `linear-gradient(150deg, hsl(${(i * 47) % 360} 70% 60%), hsl(${(i * 47 + 40) % 360} 70% 45%))` }}>
              <span style={{ fontSize: 13 }}>{r.address?.slice(2, 4).toUpperCase()}</span>
            </span>
            <span className="kf-rank-name"><b>{shortAddr(r.address)}</b><i>{r.launched} launched</i></span>
            <span className="kf-rank-val">{fmtUsd(vol(r))}</span>
          </a>
        ))}
        {rows.length === 0 && <div className="kf-empty">No creators found.</div>}
      </div>
    </div>
  );
}
