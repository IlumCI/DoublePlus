import { useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { type Venture } from "./client";
import { ago, fmtEth, fmtMcap, pct, short, StatusBadge, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";
import { env } from "../lib/env";

/** Platform aggregates plus the full index of every raise ever filed. */
export function Stats() {
  const ventures = useVentures();
  const ethUsd = useEthUsd();
  const [q, setQ] = useState("");
  const [state, setState] = useState("");

  const totals = useMemo(() => {
    const list = ventures ?? [];
    const raised = list.reduce((a, v) => a + v.raisedWei, 0n);
    const graduated = list.filter((v) => v.phase === "graduated");
    const failed = list.filter((v) => v.phase === "failed");
    const refunded = failed.reduce((a, v) => a + v.raisedWei, 0n);
    return {
      count: list.length,
      raised,
      graduated: graduated.length,
      gradRate: list.length > 0 ? (graduated.length / list.length) * 100 : 0,
      refunded,
      liveNow: list.filter((v) => v.phase === "raising" || v.phase === "expired").length,
      avgTax: list.length > 0
        ? list.reduce((a, v) => a + (v.policy.buyTaxBps + v.policy.sellTaxBps) / 2, 0) / list.length / 100
        : 0,
    };
  }, [ventures]);

  const rows = useMemo(() => {
    let list = [...(ventures ?? [])];
    if (state) list = list.filter((v) => v.phase === state);
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((v) =>
        v.name.toLowerCase().includes(needle) || v.symbol.toLowerCase().includes(needle) ||
        (v.meta.pitch ?? "").toLowerCase().includes(needle) || v.address.toLowerCase().includes(needle));
    }
    return list.sort((a, b) => b.createdAt - a.createdAt);
  }, [ventures, q, state]);

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Stats</h1>
        <p style={{ maxWidth: "58ch", color: "var(--dim)", fontSize: 13 }}>
          Platform totals, read straight off {env.chainName}. No indexer sits between these numbers and the chain.
        </p>
      </div>

      <div className="dp-three-col">
        <Stat k="Total raised on curves" v={`${fmtEth(totals.raised, 4)} ETH`} foot={`across ${totals.count} raises filed`} />
        <Stat k="Graduation rate" v={`${totals.gradRate.toFixed(1)}%`} foot={`${totals.graduated} of ${totals.count} reached target`} />
        <Stat k="Refunded to backers" v={`${fmtEth(totals.refunded, 4)} ETH`} foot="100% of failed-raise deposits" />
        <Stat k="Raising right now" v={String(totals.liveNow)} foot="open curves accepting backers" />
        <Stat k="Average trade tax" v={`${totals.avgTax.toFixed(2)}%`} foot="founder-set, 0–4% each side" />
        <Stat k="Protocol fee" v={`${(Number(import.meta.env.VITE_PLATFORM_FEE_BPS ?? 100) / 100).toFixed(2)}%`} foot="per trade; 20% of it to referrers" />
      </div>

      <div className="dp-archive-filters">
        <label>Status
          <select value={state} onChange={(e) => setState(e.target.value)}>
            <option value="">any</option>
            <option value="raising">raising</option>
            <option value="expired">funded</option>
            <option value="graduated">trading</option>
            <option value="failed">failed</option>
          </select>
        </label>
        <label>Search
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="name, ticker, pitch, address…" size={24} />
        </label>
      </div>

      <div className="dp-form-sheet">
        <p className="dp-sec">Every raise filed <span className="dp-agate">newest first</span></p>
        {ventures === null ? <p className="dp-agate">Reading the chain…</p> : (
          <table className="dp-docket">
            <thead><tr>
              <th>Project</th><th className="dp-num">Raised</th><th className="dp-num">Target</th>
              <th className="dp-num">Market cap</th><th>Age</th><th>Creator</th><th>Status</th>
            </tr></thead>
            <tbody>
              {rows.length === 0 ? (
                <tr><td colSpan={7} className="dp-agate">No results.</td></tr>
              ) : rows.map((v: Venture) => (
                <tr key={v.address}>
                  <td>
                    <Link className="dp-row-link" to={`/venture/${v.address}`} viewTransition>
                      <b>{v.name}</b> <span className="dp-mono" style={{ fontSize: 10.5 }}>${v.symbol}</span>
                    </Link>
                  </td>
                  <td className="dp-num">{fmtEth(v.raisedWei, 3)}</td>
                  <td className="dp-num">{fmtEth(v.targetRaiseWei, 3)}</td>
                  <td className="dp-num">{fmtMcap(v, ethUsd)}</td>
                  <td className="dp-mono" style={{ fontSize: 11 }}>{ago(v.createdAt)}</td>
                  <td className="dp-mono" style={{ fontSize: 11 }}>{short(v.creator)}</td>
                  <td><StatusBadge v={v} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <p className="dp-agate" style={{ marginTop: 14 }}>
        Funding percentages are computed from the curve's own state:{" "}
        {rows.length > 0 ? `${pct(rows[0].raisedWei, rows[0].targetRaiseWei).toFixed(1)}% on the newest raise.` : "nothing filed yet."}
      </p>
    </div>
  );
}

function Stat({ k, v, foot }: { k: string; v: string; foot: string }) {
  return (
    <div className="dp-record">
      <span className="dp-k">{k}</span>
      <span className="dp-val">{v}</span>
      <p className="dp-foot dp-agate">{foot}</p>
    </div>
  );
}
