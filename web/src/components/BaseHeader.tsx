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
              {/* stonks meme man */}
              <rect x="2" y="2" width="36" height="36" rx="10" fill="#0f1113" />
              <g transform="translate(4 4) scale(0.8)">
                <path d="M6 40 V34.7 C6 30.3 11 27.7 20 27.7 C29 27.7 34 30.3 34 34.7 V40 Z" fill="#c9cdd2" />
                <path d="M16 27.7 L20 36 L24 27.7 Z" fill="#0f1113" />
                <path d="M20 35 L18.3 29 H21.7 Z" fill="#22c55e" />
                <rect x="17.4" y="23" width="5.2" height="6" rx="2" fill="#c9cdd2" />
                <ellipse cx="9.8" cy="14" rx="1.8" ry="2.8" fill="#c9cdd2" /><ellipse cx="30.2" cy="14" rx="1.8" ry="2.8" fill="#c9cdd2" />
                <path d="M20 2.4 C13 2.4 10 8 10 14.7 C10 22 14.3 26 20 26 C25.7 26 30 22 30 14.7 C30 8 27 2.4 20 2.4 Z" fill="#c9cdd2" />
                <ellipse cx="17.3" cy="14" rx="1.05" ry="1.4" fill="#2b2f36" /><ellipse cx="23.3" cy="14" rx="1.05" ry="1.4" fill="#2b2f36" />
                <path d="M20 14.3 C19.3 17 18.6 18.3 18 19 C18.7 19.7 20.3 19.7 21 19" stroke="#2b2f36" strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.7" />
                <path d="M17.6 21.7 H22.4" stroke="#2b2f36" strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
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
