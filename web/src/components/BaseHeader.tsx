import { lazy, Suspense, useEffect, useState } from "react";
import { Link, NavLink, useLocation, useNavigate } from "react-router-dom";

import { BRAND } from "../lib/brand";
import { BaseTicker } from "./BaseTicker";
import { KoiIcon } from "./base/KoiIcon";
import { Skeleton } from "./ui";
import { useWallet } from "../lib/useWallet";

// The launch form rides in a slide-up sheet on mobile, so it loads lazily —
// the header itself stays light.
const LaunchForm = lazy(() => import("../pages/LaunchBase").then((m) => ({ default: m.LaunchBase })));

function WalletButton() {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
  if (isConnected && address) {
    return (
      <button onClick={() => disconnect()} className="kf-icon-btn kf-connect on" title="Disconnect">
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
                <linearGradient id="koiMark" x1="6" y1="4" x2="34" y2="36" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#ff5fb6" /><stop offset="1" stopColor="#ff2f9c" />
                </linearGradient>
              </defs>
              <path d="M20 3c-6.5 4-9 8.7-9 14.5 0 3.4 1.6 6.2 4.2 7.9-2.9.5-5.2 2.3-6.7 5.1 3.6 4.2 8 6.5 12.8 6.5 3.4 0 6-1.9 6-5 0-2.2-1.3-3.9-3.4-4.7 4.7-1.9 7.6-6 7.6-11.3C31.5 12.8 27.4 6.7 20 3Z" fill="url(#koiMark)" />
              <circle cx="17.4" cy="15.6" r="2.5" fill="#fff" />
              <circle cx="18.1" cy="15.9" r="1.1" fill="#3a0022" />
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
    </>
  );
}
