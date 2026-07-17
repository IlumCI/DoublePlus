import { useEffect, useRef, useState } from "react";
import type { Address } from "@launchpad/sdk";

import { env } from "../lib/env";
import { Icon } from "./Icon";

/**
 * Share a token: post it to X with its cashtag, copy its page link, or jump
 * straight to the Uniswap pool or the block explorer. Uniswap is the venue —
 * every Quiverpad token trades in a live Uniswap V4 WETH pool.
 */
export function ShareMenu({ address, symbol, name }: { address: Address; symbol: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onEsc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, [open]);

  const pageUrl = typeof window !== "undefined" ? `${window.location.origin}/token/${address}` : "";
  const explorer = env.explorerUrl ? env.explorerUrl.replace(/\/$/, "") : "";
  const scanUrl = explorer ? `${explorer}/token/${address}` : "";
  // Uniswap's hosted interface, pointed at this token's WETH pool.
  const uniswapUrl = `https://app.uniswap.org/swap?chain=${env.chainId}&outputCurrency=${address}`;
  const tweet =
    `https://twitter.com/intent/tweet?` +
    `text=${encodeURIComponent(`$${symbol} — ${name}\nTrading live on Quiverpad, holders earn real stock rewards.`)}` +
    `&url=${encodeURIComponent(pageUrl)}`;

  const copyLink = () => {
    navigator.clipboard.writeText(pageUrl).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    });
  };

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        title="Share"
        className="flex items-center gap-1 rounded border border-edge bg-panel-2/50 px-1.5 py-0.5 text-[11px] font-medium text-ink-3 transition-colors hover:border-edge-2 hover:text-ink-2"
      >
        <Icon name="share" size={11} />
        Share
      </button>

      {open ? (
        <div className="absolute right-0 z-30 mt-1.5 w-52 overflow-hidden rounded-xl border border-edge bg-panel py-1 shadow-lg shadow-black/40">
          <Item
            icon="twitter"
            label="Share on X"
            onClick={() => {
              window.open(tweet, "_blank", "noopener,noreferrer");
              setOpen(false);
            }}
          />
          <Item icon={copied ? "verified" : "copy"} label={copied ? "Link copied" : "Copy link"} onClick={copyLink} />
          <Item
            icon="trade"
            label="Trade on Uniswap"
            onClick={() => {
              window.open(uniswapUrl, "_blank", "noopener,noreferrer");
              setOpen(false);
            }}
          />
          {scanUrl ? (
            <Item
              icon="external"
              label="View on Scan"
              onClick={() => {
                window.open(scanUrl, "_blank", "noopener,noreferrer");
                setOpen(false);
              }}
            />
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function Item({ icon, label, onClick }: { icon: Parameters<typeof Icon>[0]["name"]; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-[12.5px] font-medium text-ink-2 transition-colors hover:bg-panel-2 hover:text-ink"
    >
      <span className="grid h-4 w-4 place-items-center text-ink-3">
        <Icon name={icon} size={14} />
      </span>
      {label}
    </button>
  );
}
