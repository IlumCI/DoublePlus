import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";

import { Toasts } from "../components/ui";
import { env } from "../lib/env";
import { useWallet } from "../lib/useWallet";
import { Consign } from "./Consign";
import { Floor } from "./Floor";
import { LotPage } from "./Lot";
import { Gavel } from "./ui";
import "./hammr.css";

/** Self-contained auction-house app: its own chrome, routes and design. */
export function HammrApp() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<Floor />} />
            <Route path="/lot/:address" element={<LotPage />} />
            <Route path="/consign" element={<Consign />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </main>
        <Footer />
        <Toasts />
      </div>
    </BrowserRouter>
  );
}

function Header() {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
  return (
    <header className="hm-header">
      <div className="hm-shell flex h-16 items-center gap-5">
        <Link to="/" className="flex items-center gap-2.5">
          <Gavel size={24} />
          <span className="hm-word">hammr<b>.fun</b></span>
        </Link>
        <nav className="hm-nav flex items-center gap-1">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "on" : "")}>The Floor</NavLink>
          <NavLink to="/consign" className={({ isActive }) => (isActive ? "on" : "")}>Consign</NavLink>
        </nav>
        <div className="flex-1" />
        <span className="hm-chip hidden md:inline-flex">{env.chainName}</span>
        {isConnected && address ? (
          <button className="hm-connect" onClick={() => disconnect()} title="Disconnect">
            {`${address.slice(0, 4)}…${address.slice(-4)}`}
          </button>
        ) : (
          <button className="hm-connect" onClick={connectFirst} disabled={isPending}>
            {isPending ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="hm-footer">
      <div className="hm-shell flex h-14 items-center gap-5">
        <span className="hm-word" style={{ fontSize: 15 }}>hammr<b>.fun</b></span>
        <span className="hidden sm:inline">every coin goes under the hammer</span>
        <div className="flex-1" />
        <a href="https://x.com/hammrfun" target="_blank" rel="noreferrer">X</a>
        {env.explorerUrl && <a href={env.explorerUrl} target="_blank" rel="noreferrer">Explorer</a>}
      </div>
    </footer>
  );
}
