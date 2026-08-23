import { lazy, Suspense, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

import { BRAND } from "../lib/brand";
import { BaseTicker } from "./BaseTicker";
import { KoiIcon } from "./base/KoiIcon";
import { WalletSheet } from "./base/WalletSheet";
import { Skeleton } from "./ui";
import { useWallet } from "../lib/useWallet";
import { useUi } from "../store";

// The launch form rides in a slide-up sheet on mobile, so it loads lazily —
// the header itself stays light.
const LaunchForm = lazy(() => import("../pages/LaunchBase").then((m) => ({ default: m.LaunchBase })));

function WalletButton() {
  const { address, isConnected, connectFirst, isPending } = useWallet();
  const setWalletOpen = useUi((s) => s.setWalletOpen);
  if (isConnected && address) {
    return (
      <button onClick={() => setWalletOpen(true)} className="kf-icon-btn kf-connect on" title="Wallet">
        <span className="kf-dot" />
        {`${address.slice(0, 4)}…${address.slice(-4)}`}
      </button>
    );
  }
  return (
    <button onClick={connectFirst} disabled={isPending} className="kf-icon-btn kf-connect">
      <KoiIcon name="wallet" size={17} />
      {isPending ? "Connecting" : "Connect"}
    </button>
  );
}

const NAV = [
  { to: "/", end: true, label: "Tokens" },
  { to: "/feed", label: "Feed" },
  { to: "/party", label: "Pool party" },
  { to: "/leaderboard", label: "Leaderboard" },
  { to: "/search", label: "Search" },
  { to: "/docs", label: "How it Works" },
];

/**
 * koi.fun chrome: the marquee countdown band, then the black bar — mark +
 * wordmark left, text nav (desktop), pink launch action and wallet right.
 * Tapping the rocket slides the launch form up as a bottom sheet on mobile;
 * on desktop it routes to the /launch page.
 */
export function BaseHeader() {
  const nav = useNavigate();
  const loc = useLocation();
  const [sheet, setSheet] = useState(false);
  const walletOpen = useUi((s) => s.walletOpen);
  const setWalletOpen = useUi((s) => s.setWalletOpen);

  // A successful launch navigates to the new token page; close the sheet on
  // any route change so it never lingers over the next screen.
  useEffect(() => { setSheet(false); }, [loc.pathname]);
  useEffect(() => {
    document.body.style.overflow = sheet ? "hidden" : "";
    return () => { document.body.style.overflow = ""; };
  }, [sheet]);

  const openLaunch = () => {
    if (window.innerWidth >= 1024) nav("/launch");
    else setSheet(true);
  };

  return (
    <>
      <BaseTicker />
      <header className="kf-hdr sticky top-0 z-40">
        <div className="kf-hdr-inner">
          <Link to="/" aria-label={BRAND.name} className="kf-brand">
            <img
              className="kf-brand-mark"
              src="/stonk-logo.jpg"
              alt=""
              aria-hidden
              style={{ borderRadius: 11, objectFit: "cover" }}
            />
            <span className="kf-brand-name">{BRAND.name}<span className="kf-tld">{BRAND.tld}</span></span>
          </Link>

          <nav className="kf-nav-links" aria-label="Primary">
            {NAV.map((n) => (
              <NavLink key={n.to} to={n.to} end={n.end} className={({ isActive }) => (isActive ? "on" : "")}>{n.label}</NavLink>
            ))}
          </nav>

          <button onClick={openLaunch} className="kf-icon-btn kf-rocket" aria-label="Launch a token" aria-haspopup="dialog" style={{ marginLeft: "auto" }}>
            <KoiIcon name="rocket" size={21} />
            <span className="kf-rocket-label">Launch a token</span>
          </button>

          <WalletButton />
        </div>
      </header>

      {sheet ? (
        <div className="kf-sheet-backdrop" onClick={() => setSheet(false)}>
          <div className="kf-sheet" role="dialog" aria-label="Launch a token" onClick={(e) => e.stopPropagation()}>
            <div className="kf-sheet-grip" />
            <Suspense fallback={<Skeleton className="h-64" />}>
              <LaunchForm onCancel={() => setSheet(false)} />
            </Suspense>
          </div>
        </div>
      ) : null}

      <WalletSheet open={walletOpen} onClose={() => setWalletOpen(false)} />
    </>
  );
}
