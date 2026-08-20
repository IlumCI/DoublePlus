import { Link } from "react-router-dom";

import { BRAND, IS_STOCK_BOARD } from "../lib/brand";
import { env } from "../lib/env";
import { BaseFooter } from "./BaseFooter";

/**
 * Slim site footer: wordmark left, product links right. Sits below the page
 * content on every route; on mobile the default flavor's bottom nav floats
 * above it, so links stay reachable via the page end.
 */
export function Footer() {
  if (IS_STOCK_BOARD) return <BaseFooter />;
  return (
    <footer className="border-t border-edge">
      <div className="mx-auto flex h-12 max-w-6xl items-center gap-4 px-4 text-[12px] text-ink-3 sm:px-5">
        <span className="font-extrabold lowercase tracking-tight text-ink-2">
          {BRAND.name}
          <span className="text-accent-ink">{BRAND.tld}</span>
        </span>
        <span className="hidden sm:inline">{BRAND.tagline}</span>
        <div className="flex-1" />
        <nav className="flex items-center gap-4" aria-label="Footer">
          <Link to="/docs" className="font-semibold text-ink-2 transition-colors hover:text-ink">
            Docs
          </Link>
          <a
            href={BRAND.twitter}
            target="_blank"
            rel="noreferrer"
            className="font-semibold text-ink-2 transition-colors hover:text-ink"
          >
            X
          </a>
          {env.explorerUrl && (
            <a
              href={env.explorerUrl}
              target="_blank"
              rel="noreferrer"
              className="font-semibold text-ink-2 transition-colors hover:text-ink"
            >
              Explorer
            </a>
          )}
        </nav>
      </div>
    </footer>
  );
}
