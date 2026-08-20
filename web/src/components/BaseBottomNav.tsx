import { Link, useLocation } from "react-router-dom";

import { KoiIcon, type KoiIconName } from "./base/KoiIcon";

const MAIN: { icon: KoiIconName; to: string; label: string }[] = [
  { icon: "bar-chart", to: "/", label: "Tokens" },
  { icon: "flame", to: "/party", label: "Pool party" },
  { icon: "trending-up", to: "/leaderboard", label: "Leaderboard" },
  { icon: "trophy", to: "/feed", label: "Feed" },
  { icon: "wallet", to: "/profile", label: "Wallet" },
];

/** koi.fun floating bottom navigation — fixed pill, pink active icon, with a
 *  separated search action, mirroring the reference chrome. */
export function BaseBottomNav() {
  const loc = useLocation();
  const isActive = (to: string) => (to === "/" ? loc.pathname === "/" : loc.pathname.startsWith(to));

  // The search page docks its own search bar and the token page docks the
  // Buy/Sell pair where the nav would sit, matching the reference chrome.
  if (loc.pathname.startsWith("/search") || loc.pathname.startsWith("/token/")) return null;

  return (
    <nav className="kf-nav" aria-label="Primary">
      <div className="kf-nav-main">
        {MAIN.map((n) => (
          <Link key={n.icon} to={n.to} className={`kf-nav-btn ${isActive(n.to) ? "on" : ""}`} aria-label={n.label} aria-current={isActive(n.to) ? "page" : undefined}>
            <KoiIcon name={n.icon} size={21} />
          </Link>
        ))}
      </div>
      <div className="kf-nav-sep" />
      <Link to="/search" className="kf-nav-search" aria-label="Search">
        <KoiIcon name="search" size={19} />
      </Link>
    </nav>
  );
}
