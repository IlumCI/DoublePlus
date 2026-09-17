import { useEffect, useState } from "react";

import { short } from "./ui";
import { usePageMeta } from "./seo";
import { env } from "../lib/env";

interface Epoch {
  epoch: number;
  totalVolumeEth: string;
  budgetEth: string;
  generatedAt?: string;
  dryRun?: boolean;
  makerAttribution?: string;
  // Early manifests predate the maker split, so every list is optional.
  ventures?: { coin: string; volumeEth: string; burnedTokens: string; burnTx?: string }[];
  rebates?: { trader: string; amountEth: string; tx?: string }[];
  makers?: { maker: string; amountEth: string; tx?: string }[];
}

const num = (s: string, digits = 6) => {
  const v = Number(s);
  return Number.isFinite(v) ? v.toLocaleString("en-US", { maximumFractionDigits: digits }) : s;
};
const tokens = (s: string) => {
  const v = Number(s) / 1e18;
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

/** Weekly rewards: the keeper's published manifests, rendered verbatim. */
export function Flywheel() {
  usePageMeta("Weekly rewards");
  const [epochs, setEpochs] = useState<Epoch[] | null>(null);

  useEffect(() => {
    let live = true;
    fetch("/rewards/venture/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then(async (idx) => {
        if (!idx?.epoch) return [];
        const want = [];
        for (let n = idx.epoch; n >= Math.max(1, idx.epoch - 11); n--) want.push(n);
        const loaded = await Promise.all(want.map((n) =>
          fetch(`/rewards/venture/epoch-${n}.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null)));
        return loaded.filter(Boolean) as Epoch[];
      })
      .then((e) => { if (live) setEpochs(e ?? []); })
      .catch(() => { if (live) setEpochs([]); });
    return () => { live = false; };
  }, []);

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Weekly rewards</h1>
        <p style={{ maxWidth: "66ch", color: "var(--dim)", fontSize: 13 }}>
          Every Monday at 12:00 UTC a slice of protocol revenue is returned three ways: <b>40%</b> buys back and
          burns the highest-volume tokens, <b>30%</b> rebates the most active traders, <b>30%</b> pays outside
          liquidity providers. Each epoch publishes a manifest listing every transaction, so every line below can
          be checked on the explorer.
        </p>
      </div>

      {epochs === null ? (
        <p className="dp-agate">Reading the manifests…</p>
      ) : epochs.length === 0 ? (
        <div className="dp-panel" style={{ padding: "40px 20px", textAlign: "center" }}>
          <h3 style={{ fontSize: 18, color: "var(--paper)" }}>No epochs settled yet.</h3>
          <p className="dp-agate" style={{ marginTop: 6 }}>
            The keeper publishes a manifest here the first Monday after trading starts.
          </p>
        </div>
      ) : epochs.map((e) => {
        const burns = e.ventures ?? [];
        const rebates = e.rebates ?? [];
        const makers = e.makers ?? [];
        return (
        <article className="dp-epoch" key={e.epoch}>
          <header>
            <h3>EPOCH {e.epoch}</h3>
            <span className="dp-mono" style={{ fontSize: 11 }}>
              volume <b style={{ color: "var(--text)" }}>{num(e.totalVolumeEth)} ETH</b> · distributed{" "}
              <b style={{ color: "var(--text)" }}>{num(e.budgetEth)} ETH</b>
            </span>
            <span style={{ flex: 1 }} />
            <a className="dp-mono" style={{ fontSize: 11 }} href={`/rewards/venture/epoch-${e.epoch}.json`} target="_blank" rel="noreferrer">manifest.json ↗</a>
            {e.dryRun
              ? <span className="dp-badge dp-soon">dry run</span>
              : <span className="dp-badge dp-grad">settled</span>}
          </header>
          <div className="dp-cols">
            <div>
              <h4>Buybacks &amp; burns — 40%</h4>
              {burns.length === 0 ? <p className="dp-agate">none this epoch</p> : (
                <ul>{burns.map((v) => (
                  <li key={v.coin}>
                    <span>{short(v.coin)}</span>
                    <span>
                      {tokens(v.burnedTokens)} burned
                      {v.burnTx && env.explorerUrl && <> <a href={`${env.explorerUrl}/tx/${v.burnTx}`} target="_blank" rel="noreferrer">↗</a></>}
                    </span>
                  </li>
                ))}</ul>
              )}
            </div>
            <div>
              <h4>Trader rebates — 30%</h4>
              {rebates.length === 0 ? <p className="dp-agate">none this epoch</p> : (
                <ul>{rebates.map((r) => (
                  <li key={r.trader}>
                    <span>{short(r.trader)}</span>
                    <span>
                      {num(r.amountEth)} ETH
                      {r.tx && env.explorerUrl && <> <a href={`${env.explorerUrl}/tx/${r.tx}`} target="_blank" rel="noreferrer">↗</a></>}
                    </span>
                  </li>
                ))}</ul>
              )}
            </div>
            <div>
              <h4>LP rewards — 30%</h4>
              {makers.length === 0 ? (
                <p className="dp-agate">
                  No outside liquidity providers this epoch — their share rolled into the buyback pot, as the
                  manifest records.
                </p>
              ) : (
                <ul>{makers.map((m) => (
                  <li key={m.maker}><span>{short(m.maker)}</span><span>{num(m.amountEth)} ETH</span></li>
                ))}</ul>
              )}
            </div>
          </div>
        </article>
        );
      })}

      <p className="dp-agate" style={{ marginTop: 20 }}>
        Distribution is run by the protocol treasury and published in full each week; the split itself is policy,
        not yet contract-enforced. Every transaction above is on the explorer.
      </p>
    </div>
  );
}
