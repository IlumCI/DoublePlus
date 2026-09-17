import { useEffect, useState } from "react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { useSwitchChain } from "wagmi";

import { Toasts } from "../components/ui";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";
import { useWallet } from "../lib/useWallet";
import { Board } from "./Board";
import { Desk } from "./Desk";
import { Docs } from "./Docs";
import { Flywheel } from "./Flywheel";
import { LaunchVenture } from "./Launch";
import { Stats } from "./Stats";
import { VenturePage } from "./Venture";
import { captureRef } from "./referral";
import { ago, FilterDefs, pct } from "./ui";
import { useVentures } from "./useVentures";
import "./venture.css";

captureRef();

const NAV: [string, string, string][] = [
  ["/", "Raises", "Raises"],
  ["/desk", "Portfolio", "Portfolio"],
  ["/rewards", "Rewards", "Rewards"],
  ["/stats", "Stats", "Stats"],
  ["/docs", "Docs", "Docs"],
];

/** doubleplus: day-zero funding for startups and research projects. */
export function VentureApp() {
  return (
    <BrowserRouter>
      <FilterDefs />
      <Topbar />
      <ChainBar />
      <ActivityStrip />
      <main>
        <Routes>
          <Route path="/" element={<Board />} />
          <Route path="/venture/:address" element={<VenturePage />} />
          <Route path="/launch" element={<LaunchVenture />} />
          <Route path="/desk" element={<Desk />} />
          <Route path="/rewards" element={<Flywheel />} />
          <Route path="/stats" element={<Stats />} />
          <Route path="/docs" element={<Docs />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </main>
      <Footer />
      <MobileNav />
      <Toasts />
    </BrowserRouter>
  );
}

function Topbar() {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const location = useLocation();
  const [q, setQ] = useState(params.get("q") ?? "");

  // Keep the field in step with the URL when the board clears its own filters.
  useEffect(() => { setQ(params.get("q") ?? ""); }, [params]);

  const search = (value: string) => {
    setQ(value);
    const next = new URLSearchParams(location.pathname === "/" ? params : undefined);
    if (value) next.set("q", value); else next.delete("q");
    navigate({ pathname: "/", search: next.toString() }, { replace: location.pathname === "/" });
  };

  return (
    <header className="dp-topbar">
      <div className="dp-shell">
        <Link className="dp-brand" to="/" viewTransition>{BRAND.name}<sub>{BRAND.tld}</sub></Link>
        <nav className="dp-topnav">
          {NAV.map(([to, label]) => (
            <NavLink key={to} to={to} end={to === "/"} viewTransition
              className={({ isActive }) => (isActive ? "on" : "")}>
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="dp-tb-search">
          <input value={q} onChange={(e) => search(e.target.value)} placeholder="Search projects…" aria-label="Search projects" />
        </div>
        <Link className="dp-btn-create" to="/launch" viewTransition>+ Create</Link>
        {isConnected && address ? (
          <button className="dp-btn-connect" onClick={() => disconnect()} title="Disconnect">
            {`${address.slice(0, 4)}…${address.slice(-4)}`}
          </button>
        ) : (
          <button className="dp-btn-connect" onClick={connectFirst} disabled={isPending}>
            {isPending ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}

/** Mobile gets a bottom tab bar; the top nav has nowhere to go at 390px. */
function MobileNav() {
  return (
    <nav className="dp-mobilenav" aria-label="Primary">
      {NAV.map(([to, , short]) => (
        <NavLink key={to} to={to} end={to === "/"} viewTransition className={({ isActive }) => (isActive ? "on" : "")}>
          {short}
        </NavLink>
      ))}
    </nav>
  );
}

/** Wrong network is the most common reason a trade fails. Say so, and fix it. */
function ChainBar() {
  const { isConnected, chainId } = useWallet();
  const { switchChain } = useSwitchChain();
  if (!isConnected || !chainId || chainId === env.chainId) return null;
  return (
    <div className="dp-chainbar">
      <div className="dp-shell">
        <span>Your wallet is on another network. {BRAND.name} runs on {env.chainName}.</span>
        <button className="dp-btn-connect" onClick={() => switchChain({ chainId: env.chainId })}>
          Switch to {env.chainName}
        </button>
      </div>
    </div>
  );
}

/** Real, clickable, and honest when the board is quiet. No marquee. */
function ActivityStrip() {
  const { ventures } = useVentures();
  if (!ventures) return null;
  if (ventures.length === 0) {
    return (
      <div className="dp-activity">
        <div className="dp-shell"><span className="dp-quiet">No raises filed yet — the board fills as projects launch.</span></div>
      </div>
    );
  }
  const recent = [...ventures].sort((a, b) => b.createdAt - a.createdAt).slice(0, 6);
  return (
    <div className="dp-activity">
      <div className="dp-shell">
        {recent.map((v) => (
          <Link key={v.address} to={`/venture/${v.address}`} viewTransition>
            ${v.symbol}{" "}
            {v.phase === "graduated" ? "trading"
              : v.phase === "failed" ? "refunds open"
              : v.phase === "expired" ? "fully funded"
              : `${pct(v.raisedWei, v.targetRaiseWei).toFixed(0)}% funded`}
            <span className="dp-when"> · {ago(v.createdAt)} ago</span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function Footer() {
  return (
    <footer className="dp-footer">
      <div className="dp-shell">
        <span>{BRAND.name}{BRAND.tld} — {env.chainName}</span>
        <span>protocol fee 1% per trade · 20% of it to referrers</span>
        {env.explorerUrl && <a href={env.explorerUrl} target="_blank" rel="noreferrer">explorer ↗</a>}
        <Link to="/docs" viewTransition>docs</Link>
        <span>Project tokens, not registered securities. Contracts are unaudited. Back only what you can afford to lose.</span>
      </div>
    </footer>
  );
}
