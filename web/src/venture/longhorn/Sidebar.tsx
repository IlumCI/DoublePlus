import { Link } from "react-router-dom";

import { env } from "../../lib/env";
import type { Venture } from "../client";
import { ago, pct, useEthUsd, useTick } from "../ui";

/** Next flywheel epoch: the keeper runs Mondays 12:00 UTC (.github/workflows/venture-keepers.yml). */
function nextEpoch(now: number): number {
  const d = new Date(now);
  const t = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 12);
  const daysAhead = (8 - new Date(t).getUTCDay()) % 7; // 1 = Monday
  let next = t + daysAhead * 86_400_000;
  if (next <= now) next += 7 * 86_400_000;
  return next;
}

function span(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400), h = Math.floor((s % 86_400) / 3600), m = Math.floor((s % 3600) / 60);
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${s % 60}s`;
}

function Tile({ title, children, to }: { title: string; children: React.ReactNode; to?: string }) {
  return (
    <section className="lh-tile">
      <header>{to ? <Link to={to} viewTransition>{title}</Link> : title}</header>
      <div className="lh-tile-body">{children}</div>
    </section>
  );
}

/**
 * Longhorn's Sidebar, reissued as market gadgets: the slideshow and RSS
 * tiles become the hottest and newest raises, and the sync tile counts down
 * to the next rewards epoch. No clock: the floor has no time of day.
 */
export function Sidebar({ ventures }: { ventures: Venture[] | null }) {
  const now = useTick();
  const ethUsd = useEthUsd();
  const live = (ventures ?? []).filter((v) => v.phase === "raising");
  const hot = [...live].sort((a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei)).slice(0, 4);
  const fresh = [...(ventures ?? [])].sort((a, b) => b.createdAt - a.createdAt).slice(0, 4);

  return (
    <aside className="lh-sidebar" aria-label="Market sidebar">
      <Tile title="Market">
        <div className="lh-kv"><span>ETH</span><b>{ethUsd > 0 ? `$${ethUsd.toLocaleString(undefined, { maximumFractionDigits: 0 })}` : "—"}</b></div>
        <div className="lh-kv"><span>Live raises</span><b>{ventures ? live.length : "—"}</b></div>
        <div className="lh-kv"><span>Trading</span><b>{ventures ? ventures.filter((v) => v.phase === "graduated").length : "—"}</b></div>
        <div className="lh-sub"><i className="lh-dot" /> {env.chainName}</div>
      </Tile>

      <Tile title="Hot raises" to="/">
        {hot.length === 0 && <div className="lh-sub">{ventures ? "No live raises right now." : "Loading…"}</div>}
        {hot.map((v) => {
          const p = pct(v.raisedWei, v.targetRaiseWei);
          return (
            <Link key={v.address} className="lh-row" to={`/venture/${v.address}`} viewTransition>
              <span className="lh-sym">${v.symbol}</span>
              <span className="lh-num">{p.toFixed(0)}%</span>
              <span className="lh-meter"><i style={{ width: `${Math.min(100, p)}%` }} /></span>
            </Link>
          );
        })}
      </Tile>

      <Tile title="Just launched" to="/">
        {fresh.length === 0 && <div className="lh-sub">{ventures ? "Nothing yet. Be first." : "Loading…"}</div>}
        {fresh.map((v) => (
          <Link key={v.address} className="lh-row" to={`/venture/${v.address}`} viewTransition>
            <span className="lh-sym">${v.symbol}</span>
            <span className="lh-sub">{ago(v.createdAt)} ago</span>
          </Link>
        ))}
      </Tile>

      <Tile title="Rewards" to="/rewards">
        <div className="lh-sub">Next epoch in</div>
        <div className="lh-count">{span(nextEpoch(now) - now)}</div>
        <div className="lh-sub">Buybacks, rebates, LP rewards</div>
      </Tile>
    </aside>
  );
}
