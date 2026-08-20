import { useState } from "react";
import type { TokenSummary } from "@launchpad/sdk";

import { OFFICIAL_LOGOS } from "../lib/officialLogos";
import { QuiverMark } from "./QuiverMark";

export function TokenLogo({ token, size = 40 }: { token: TokenSummary; size?: number }) {
  const [failed, setFailed] = useState(false);
  // Official tokens carry a curated mark that wins over on-chain metadata.
  const logo = OFFICIAL_LOGOS[token.address?.toLowerCase()] ?? token.metadata?.logo;
  const ok = !failed && logo && /^(https?:|ipfs:|data:)/.test(String(logo));
  const src = ok
    ? String(logo).startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${String(logo).slice(7)}`
      : String(logo)
    : null;

  const inner = (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-lg bg-panel-2 ring-1 ring-edge"
      style={{ width: size, height: size }}
    >
      {src ? (
        <img
          src={src}
          alt=""
          width={size}
          height={size}
          loading="lazy"
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <QuiverMark />
      )}
    </span>
  );

  // Larger avatars carry the Base network badge, marking the coin as on Base.
  if (size < 30) return inner;
  return (
    <span className="kf-logo-wrap" style={{ width: size, height: size }}>
      {inner}
      <span className="kf-badge">
        <svg viewBox="0 0 40 40" aria-hidden>
          <circle cx="20" cy="20" r="20" fill="#fff" />
          <path d="M24 2.45 A18 18 0 1 0 24 37.55 Z" fill="#0052FF" />
        </svg>
      </span>
    </span>
  );
}
