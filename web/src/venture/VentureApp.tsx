import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";

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
import { FilterDefs, fmtMcap, pct, useEthUsd } from "./ui";
import { useVentures } from "./useVentures";
import "./venture.css";

captureRef();

const NAV: [string, string][] = [
  ["/", "Raises"],
  ["/desk", "Portfolio"],
  ["/rewards", "Rewards"],
  ["/stats", "Stats"],
  ["/docs", "Docs"],
];

/** doubleplus: day-zero funding for startups and research projects, issued as
 *  decentralized stocks. Its own chrome, routes and design system. */
export function VentureApp() {
  return (
    <BrowserRouter>
      <FilterDefs />
      <Topbar />
      <FeedBar />
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
      <Toasts />
    </BrowserRouter>
  );
}

function Topbar() {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
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
        <div className="dp-tb-search" />
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

/** The live strip: real board state, scrolling. A launchpad never sits still. */
function FeedBar() {
  const ventures = useVentures();
  const ethUsd = useEthUsd();
  if (!ventures || ventures.length === 0) return null;

  const items: string[] = [];
  for (const v of ventures.slice(0, 12)) {
    if (v.phase === "graduated") items.push(`$${v.symbol} mcap ${fmtMcap(v, ethUsd)} · trading`);
    else if (v.phase === "raising") items.push(`$${v.symbol} curve ${pct(v.raisedWei, v.targetRaiseWei).toFixed(0)}% funded`);
    else if (v.phase === "expired") items.push(`$${v.symbol} target reached · awaiting graduation`);
    else items.push(`$${v.symbol} refunds open`);
  }
  items.push(`${ventures.length} raises filed on ${env.chainName}`);
  const reel = items.join("  ·  ");

  return (
    <div className="dp-feedbar" aria-label="live board activity">
      <div className="dp-reel">{reel}  ·  {reel}</div>
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
        <span>not registered securities · unaudited contracts · back only what you can afford to lose</span>
      </div>
    </footer>
  );
}
