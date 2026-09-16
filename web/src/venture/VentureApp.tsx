import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";

import { Toasts } from "../components/ui";
import { BRAND } from "../lib/brand";
import { env } from "../lib/env";
import { useWallet } from "../lib/useWallet";
import { Board } from "./Board";
import { LaunchVenture } from "./Launch";
import { VenturePage } from "./Venture";
import { Flag } from "./ui";
import "./venture.css";

/** Self-contained startup-funding launchpad: its own chrome, routes and
 *  design, in the same pattern as the hammr auction app. */
export function VentureApp() {
  return (
    <BrowserRouter>
      <div className="flex min-h-screen flex-col">
        <Header />
        <main className="flex-1">
          <Routes>
            <Route path="/" element={<Board />} />
            <Route path="/venture/:address" element={<VenturePage />} />
            <Route path="/launch" element={<LaunchVenture />} />
            <Route path="/how" element={<How />} />
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
    <header className="vn-header">
      <div className="vn-shell flex h-16 items-center gap-5">
        <Link to="/" className="flex items-center gap-2.5">
          <Flag size={24} />
          <span className="vn-word">{BRAND.name}<b>{BRAND.tld}</b></span>
        </Link>
        <nav className="vn-nav flex items-center gap-1">
          <NavLink to="/" end className={({ isActive }) => (isActive ? "on" : "")}>Raises</NavLink>
          <NavLink to="/launch" className={({ isActive }) => (isActive ? "on" : "")}>Found a startup</NavLink>
          <NavLink to="/how" className={({ isActive }) => (isActive ? "on" : "")}>How it works</NavLink>
        </nav>
        <div className="flex-1" />
        <span className="vn-chip hidden md:inline-flex">{env.chainName}</span>
        {isConnected && address ? (
          <button className="vn-connect" onClick={() => disconnect()} title="Disconnect">
            {`${address.slice(0, 4)}…${address.slice(-4)}`}
          </button>
        ) : (
          <button className="vn-connect" onClick={connectFirst} disabled={isPending}>
            {isPending ? "Connecting…" : "Connect"}
          </button>
        )}
      </div>
    </header>
  );
}

function Footer() {
  return (
    <footer className="vn-footer">
      <div className="vn-shell flex h-14 items-center gap-5">
        <span className="vn-word" style={{ fontSize: 15 }}>{BRAND.name}<b>{BRAND.tld}</b></span>
        <span className="hidden sm:inline">{BRAND.tagline}</span>
        <div className="flex-1" />
        {BRAND.twitterHandle && <a href={BRAND.twitter} target="_blank" rel="noreferrer">X</a>}
        {env.explorerUrl && <a href={env.explorerUrl} target="_blank" rel="noreferrer">Explorer</a>}
      </div>
    </footer>
  );
}

function How() {
  return (
    <div className="vn-shell vn-rise" style={{ paddingBottom: 90, maxWidth: 720 }}>
      <p className="vn-eyebrow mt-10">how it works</p>
      <h1 className="vn-title mt-2">Launch and fund a startup as a decentralized stock-style token.</h1>
      <p className="mt-2 text-[13px]" style={{ color: "var(--v-ink-3)" }}>
        doubleplus, from Orwell's newspeak: <i>doubleplusgood</i> — the strongest possible good. That's the bar for
        what graduates here.
      </p>

      <div className="mt-6 space-y-5 text-[14px] leading-relaxed" style={{ color: "var(--v-ink-2)" }}>
        <p>
          <b style={{ color: "var(--v-ink)" }}>1 · Found.</b> One transaction deploys your venture's coin and opens a
          funding round on a rising price curve: the earlier a backer commits, the cheaper their entry. You declare the
          full term sheet up front — the funding target, your cut of the raise (up to 30%), your vested allocation (up
          to 15%, locked and unlocking linearly only after the round succeeds), the deadline and the per-wallet cap.
          Everything is on-chain and visible to every backer before they commit.
        </p>
        <p>
          <b style={{ color: "var(--v-ink)" }}>2 · Fund.</b> Backers buy along the curve in plain ETH. Pricing is the
          exact integral of the curve, so splitting orders or sniping the first block gains nothing, and the per-wallet
          cap keeps any single buyer from cornering the round.
        </p>
        <p>
          <b style={{ color: "var(--v-ink)" }}>3 · Graduate.</b> Hit the target and anyone can trigger graduation: the
          founder's declared cut of the raise is paid out as funding, and everything else — the remaining supply and the
          rest of the raise — becomes protocol-managed liquidity in a Uniswap V4 pool.
        </p>
        <p>
          <b style={{ color: "var(--v-ink)" }}>4 · Earn.</b> The founder writes the fee policy at launch and it runs
          on-chain forever: separate buy and sell taxes (0–4% each), split across four engines in any proportion —
          the dev wallet, ETH dividends to every holder, auto-liquidity locked beside the price, and a market-making
          bid wall of standing buy support under the price. Trades in the first seconds after graduation pay a
          decaying sniper premium that lands in the bid wall: snipers fund the floor. A protocol fee of up to 1% per
          trade keeps the lights on.
        </p>
        <p>
          <b style={{ color: "var(--v-ink)" }}>Missed the deadline?</b> The round fails safe: the founder's allocation
          burns, and every backer reclaims their full spend by returning their tokens. All or nothing, like a proper
          raise.
        </p>
        <p style={{ color: "var(--v-ink-3)", fontSize: 12.5 }}>
          Plain talk: these are open, freely-transferable tokens whose economics rhyme with equity — a funded raise, a
          vested founder stake, dividend-paying trading fees. They are not registered securities, carry no legal claim
          on any company, and the contracts are unaudited. Liquidity is protocol-managed, not burned. Back what you can
          afford to lose.
        </p>
      </div>
    </div>
  );
}
