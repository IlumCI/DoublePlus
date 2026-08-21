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
              {/* derpy meme man in a Base hoodie */}
              <rect x="1.5" y="1.5" width="37" height="37" rx="11" fill="#0f1113" />
              <g transform="scale(0.3333)">
                <path d="M4 120 V102 C4 88 22 80 60 80 C98 80 116 88 116 102 V120 Z" fill="#0052FF" />
                <path d="M60 82 L52 120 H68 Z" fill="#0040cc" />
                <g transform="translate(60 104)"><circle r="8" fill="#fff" /><path d="M4 -8 A8 8 0 1 0 4 8 Z" fill="#0052FF" /></g>
                <path d="M16 54 C16 20 34 6 60 6 C86 6 104 20 104 54 C104 74 92 86 74 90 L46 90 C28 86 16 74 16 54 Z" fill="#0052FF" />
                <rect x="47" y="84" width="3" height="26" rx="1.5" fill="#eef1f5" />
                <rect x="70" y="84" width="3" height="22" rx="1.5" fill="#eef1f5" />
                <circle cx="48.5" cy="112" r="2.6" fill="#eef1f5" /><circle cx="71.5" cy="108" r="2.6" fill="#eef1f5" />
                <ellipse cx="30" cy="50" rx="5" ry="7.5" fill="#c9cdd2" /><ellipse cx="90" cy="50" rx="5" ry="7.5" fill="#c9cdd2" />
                <path d="M60 18 C40 18 31 32 31 50 C31 70 44 82 60 82 C76 82 89 70 89 50 C89 32 80 18 60 18 Z" fill="#c9cdd2" />
                <circle cx="50" cy="48" r="6" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="53" cy="50" r="2.4" fill="#20242b" />
                <circle cx="72" cy="46" r="5" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="69" cy="48" r="2" fill="#20242b" />
                <path d="M58 56 C56 62 55 65 53 67 C56 69 61 69 63 67" stroke="#20242b" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
                <path d="M50 72 Q57 78 64 72" stroke="#20242b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
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
