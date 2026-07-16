import { NavLink } from "react-router-dom";

import { Icon, type IconName } from "./Icon";

/**
 * Minimal primary nav. On mobile every tab shares the width evenly (icon over a
 * short label) so nothing is hidden off-screen; on desktop it's an inline row.
 */
const TABS: { to: string; end?: boolean; icon: IconName; label: string }[] = [
  { to: "/", end: true, icon: "explore", label: "Discover" },
  { to: "/launch", icon: "launch", label: "Launch" },
  { to: "/mine", icon: "wallet", label: "My Coins" },
];

export function NavBar() {
  return (
    <div className="border-b border-edge">
      <nav className="mx-auto -mb-px flex max-w-6xl items-stretch px-2 sm:justify-start sm:gap-6 sm:px-5">
        {TABS.map((t) => (
          <NavLink
            key={t.to}
            to={t.to}
            end={t.end}
            className={({ isActive }) =>
              `flex flex-1 flex-col items-center gap-0.5 border-b-2 py-2 text-[10px] font-medium transition-colors sm:flex-none sm:flex-row sm:gap-1.5 sm:py-2.5 sm:text-[11.5px] ${
                isActive ? "border-accent text-accent" : "border-transparent text-ink-2 hover:text-ink"
              }`
            }
          >
            <Icon name={t.icon} size={13} />
            {t.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}
