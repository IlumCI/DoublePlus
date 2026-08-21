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
  { to: "/party", label: "Pool party" },
  { to: "/leaderboard", label: "Leaderboard" },
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
            <svg className="kf-brand-mark" viewBox="0 0 40 40" fill="none" aria-hidden>
              <defs>
                <linearGradient id="stonkMark" x1="6" y1="32" x2="34" y2="8" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#16a34a" /><stop offset="1" stopColor="#4ade80" />
                </linearGradient>
              </defs>
              <rect x="3" y="3" width="34" height="34" rx="9" fill="#0a0a0a" />
              {/* ascending candlesticks */}
              <g fill="url(#stonkMark)">
                <rect x="9.1" y="16" width="1.8" height="13" rx="0.9" />
                <rect x="6.6" y="19" width="6.8" height="8" rx="2" />
                <rect x="19.1" y="11.5" width="1.8" height="15.5" rx="0.9" />
                <rect x="16.6" y="14" width="6.8" height="9.5" rx="2" />
                <rect x="29.1" y="8" width="1.8" height="15" rx="0.9" />
                <rect x="26.6" y="10" width="6.8" height="10.5" rx="2" />
              </g>
            </svg>
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
