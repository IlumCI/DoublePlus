import { useState } from "react";
import { NavLink, Link } from "react-router-dom";

import { BRAND, BRAND_FLAVOR, IS_BOARD, IS_STOCK_BOARD } from "../lib/brand";
import { BaseHeader } from "./BaseHeader";
import { env } from "../lib/env";
import { useWallet } from "../lib/useWallet";
import { Icon, type IconName } from "./Icon";
import { ThemeToggle } from "./market/ThemeToggle";

const TABS: { to: string; end?: boolean; icon: IconName; label: string }[] = [
  { to: "/", end: true, icon: "explore", label: "Discover" },
  { to: "/launch", icon: "launch", label: "Launch" },
  { to: "/bridge", icon: "trade", label: "Bridge" },
];

// The board brands have their own navigation and no bridge. The Base stock
// launchpad has no weekly flywheel, so it drops that tab.
const BOARD_TABS: { to: string; end?: boolean; icon: IconName; label: string }[] = IS_STOCK_BOARD
  ? [
      { to: "/", end: true, icon: "explore", label: "Board" },
      { to: "/launch", icon: "launch", label: "Create" },
      { to: "/profile", icon: "wallet", label: "Profile" },
    ]
  : [
      { to: "/", end: true, icon: "explore", label: "Board" },
      { to: "/flywheel", icon: "activity", label: "Flywheel" },
      { to: "/launch", icon: "launch", label: "Create" },
      { to: "/profile", icon: "wallet", label: "Profile" },
    ];

/**
 * Top bar; live wordmark left, HUD nav tabs inline on desktop, chain
 * indicator + Connect on the right. On mobile the tabs repeat in a fixed
 * bottom bar, thumb reachable. The Robinhood board brand uses a distinct
 * pump.fun-style nav instead (see BoardHeader).
 */
export function Header() {
  if (IS_STOCK_BOARD) return <BaseHeader />;
  if (IS_BOARD) return <BoardHeader />;
  return <DefaultHeader />;
}

function Wallet({ board }: { board?: boolean }) {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();
  if (isConnected && address) {
    return (
      <button
        onClick={() => disconnect()}
        className={
          board
            ? "board-connect-ghost flex items-center gap-1.5 px-3 py-1.5 text-[12.5px] font-semibold"
            : "hud-cut flex items-center gap-1.5 border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-edge-2"
        }
        title="Disconnect"
      >
        <span className="dot-live h-1.5 w-1.5 rounded-full bg-up" />
        {`${address.slice(0, 4)}…${address.slice(-4)}`}
      </button>
    );
  }
  return (
    <button
      onClick={connectFirst}
      disabled={isPending}
      className={
        board
          ? "board-connect px-4 py-1.5 text-[12.5px] font-extrabold disabled:opacity-60"
          : "hud-cut bg-accent px-4 py-1.5 text-[12.5px] font-semibold text-accent-fg transition-colors disabled:opacity-60"
      }
    >
      {isPending ? "Connecting…" : "Connect"}
    </button>
  );
}

/** Neo-brutalist top bar: wordmark, desktop nav, theme toggle, the orange
 *  "+" launch action, wallet, and a menu button on mobile. */
function BoardHeader() {
  const [menu, setMenu] = useState(false);
  return (
    <>
    <header className="board-header sticky top-0 z-40">
      <div className="relative mx-auto flex h-16 max-w-6xl items-center gap-2 px-3 sm:gap-3 sm:px-5">
        <Link to="/" aria-label={BRAND.name} className="flex shrink-0 items-center">
          <span className="text-[15px] font-extrabold lowercase tracking-tight text-ink sm:text-[17px]">
            {BRAND.name}
            <span style={{ color: "var(--nb-blue)" }}>{BRAND.tld}</span>
          </span>
        </Link>

        <nav className="nb-navlinks ml-2" aria-label="Primary">
          {BOARD_TABS.map((t) => (
            <NavLink key={t.to} to={t.to} end={t.end} className={({ isActive }) => (isActive ? "on" : "")}>
              {t.label}
            </NavLink>
          ))}
        </nav>

        <div className="flex-1" />

        <div className="board-chip hidden lg:flex">
          <span className="board-logo-dot" />
          {env.chainName}
        </div>

        <ThemeToggle />

        <Link to="/launch" className="nb-btn nb-icon orange" aria-label="Launch a coin" title="Launch a coin">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" aria-hidden>
            <path d="M12 4.5v15M4.5 12h15" />
          </svg>
        </Link>

        <Wallet board />

        <button
          type="button"
          onClick={() => setMenu((m) => !m)}
          className="nb-btn nb-icon md:!hidden"
          aria-label={menu ? "Close menu" : "Menu"}
          aria-expanded={menu}
        >
          {menu ? (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" aria-hidden>
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          ) : (
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
              <path d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          )}
        </button>

        {menu && (
          <nav className="nb-mobilenav md:hidden" aria-label="Menu" onClick={() => setMenu(false)}>
            <Link to="/">
              <Icon name="explore" size={17} />
              Board
            </Link>
            {!IS_STOCK_BOARD && (
              <Link to="/flywheel" className="blue">
                <Icon name="activity" size={17} />
                Flywheel
              </Link>
            )}
            <Link to="/launch" className="orange">
              <Icon name="launch" size={17} />
              Create token
            </Link>
            <Link to="/profile" className="green">
              <Icon name="wallet" size={17} />
              My profile
            </Link>
            <Link to="/docs">Docs</Link>
          </nav>
        )}
      </div>
    </header>
    </>
  );
}

function DefaultHeader() {
  return (
    <>
      <header className="sticky top-0 z-40 border-b border-edge bg-bg/85 backdrop-blur-md">
        <div className="mx-auto flex h-14 max-w-6xl items-center gap-4 px-4 sm:px-5">
          <Link to="/" aria-label={BRAND.name} className="flex shrink-0 items-center gap-2">
            {BRAND_FLAVOR !== "steadypads" && BRAND_FLAVOR !== "arc" && (
              <span className="dot-live h-2 w-2 rounded-full bg-up shadow-[0_0_8px_var(--color-up)]" />
            )}
            <span className="text-[15px] font-extrabold lowercase tracking-tight text-ink">
              {BRAND.name}
              <span className="text-accent-ink">{BRAND.tld}</span>
            </span>
          </Link>

          <nav className="hidden items-center gap-1.5 sm:flex" aria-label="Primary">
            {TABS.map((t) => (
              <NavLink
                key={t.to}
                to={t.to}
                end={t.end}
                className={({ isActive }) =>
                  `hud-tab flex items-center gap-1.5 px-3.5 py-1.5 text-[12.5px] font-semibold transition-colors ${
                    isActive ? "hud-tab-on text-accent-ink" : "text-ink-2 hover:text-ink"
                  }`
                }
              >
                <Icon name={t.icon} size={14} />
                {t.label}
              </NavLink>
            ))}
          </nav>

          <div className="flex-1" />

          <div className="hidden items-center gap-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-3 md:flex">
            {env.chainName}
            <span aria-hidden>·</span>
            <span className="text-ion">{env.chainId}</span>
          </div>

          <div className="flex shrink-0 items-center">
            <Wallet />
          </div>
        </div>
      </header>

      <nav
        className="fixed inset-x-0 bottom-0 z-40 border-t border-edge bg-bg/90 backdrop-blur-md sm:hidden"
        aria-label="Primary mobile"
      >
        <div className="mx-auto flex max-w-6xl items-stretch gap-2 px-3 py-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))]">
          {TABS.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              end={t.end}
              className={({ isActive }) =>
                `hud-tab flex flex-1 flex-col items-center gap-0.5 px-3 py-1.5 text-[10px] font-semibold transition-colors ${
                  isActive ? "hud-tab-on text-accent-ink" : "text-ink-2 hover:text-ink"
                }`
              }
            >
              <Icon name={t.icon} size={17} />
              {t.label}
            </NavLink>
          ))}
        </div>
      </nav>
    </>
  );
}
