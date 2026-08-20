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

  return (
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
}
