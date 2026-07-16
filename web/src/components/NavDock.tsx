import { NavLink } from "react-router-dom";

import { Icon, type IconName } from "./Icon";

/**
 * The Quiverpad nav dock — a floating pill that hovers over the page, thumb
 * reachable. Icon-only, two destinations; the active one fills with a lime
 * capsule and its glyph lifts. Not a bar, not a menu: the navigation is a
 * single object that belongs to this product.
 */
const items: { to: string; label: string; end: boolean; icon: IconName }[] = [
  { to: "/", label: "Explore", end: true, icon: "explore" },
  { to: "/launch", label: "Launch a token", end: false, icon: "launch" },
];

export function NavDock() {
  return (
    <nav
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2"
      style={{ paddingBottom: "env(safe-area-inset-bottom)" }}
      aria-label="Primary"
    >
      <div className="flex items-center gap-1 rounded-full border border-edge bg-panel/80 p-1.5 shadow-[0_8px_40px_-8px_rgba(17,17,17,0.28)] backdrop-blur-xl">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            aria-label={item.label}
            title={item.label}
            className={({ isActive }) =>
              `group grid h-12 w-12 place-items-center rounded-full transition-colors duration-200 ${
                isActive ? "bg-accent text-black" : "text-ink-2 hover:bg-panel-2 hover:text-ink"
              }`
            }
          >
            {({ isActive }) => (
              <Icon
                name={item.icon}
                size={23}
                className={`transition-transform duration-150 ease-out ${
                  isActive ? "scale-110" : "scale-100 group-hover:scale-105"
                }`}
              />
            )}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}
