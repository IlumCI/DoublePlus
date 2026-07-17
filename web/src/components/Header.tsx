import { Link } from "react-router-dom";

import { BRAND } from "../lib/brand";
import { useWallet } from "../lib/useWallet";

/**
 * Top bar — wordmark left, inline links on desktop, a single Connect action on
 * the right. On mobile the navigation lives in a bottom tab bar instead.
 */
export function Header() {
  const { address, isConnected, connectFirst, disconnect, isPending } = useWallet();

  return (
    <header className="sticky top-0 z-40 border-b border-edge bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4 sm:px-5">
        {/* Brand */}
        <Link to="/" aria-label={BRAND.name} className="shrink-0">
          <span className="text-[14px] font-extrabold uppercase tracking-tight text-ink">{BRAND.name}</span>
        </Link>

        {/* Right actions */}
        <div className="flex items-center gap-1.5">
          {isConnected && address ? (
            <button
              onClick={() => disconnect()}
              className="flex items-center gap-1.5 rounded-lg border border-edge bg-panel px-3 py-1.5 text-[12.5px] font-medium text-ink transition-colors hover:border-edge-2"
              title="Disconnect"
            >
              <span className="dot-live h-1.5 w-1.5 rounded-full bg-up" />
              {`${address.slice(0, 4)}…${address.slice(-4)}`}
            </button>
          ) : (
            <button
              onClick={connectFirst}
              disabled={isPending}
              className="rounded-lg bg-accent px-3.5 py-1.5 text-[12.5px] font-semibold text-accent-fg transition-colors hover:bg-accent-2 disabled:opacity-60"
            >
              {isPending ? "Connecting…" : "Connect"}
            </button>
          )}
        </div>
      </div>
    </header>
  );
}


