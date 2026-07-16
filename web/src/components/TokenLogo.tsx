import type { TokenSummary } from "@launchpad/sdk";

import { OFFICIAL_LOGOS } from "../lib/officialLogos";

export function TokenLogo({ token, size = 40 }: { token: TokenSummary; size?: number }) {
  // Official tokens carry a curated mark that wins over on-chain metadata.
  const logo = OFFICIAL_LOGOS[token.address?.toLowerCase()] ?? token.metadata?.logo;
  if (logo && /^(https?:|ipfs:|data:)/.test(String(logo))) {
    const src = String(logo).startsWith("ipfs://")
      ? `https://ipfs.io/ipfs/${String(logo).slice(7)}`
      : String(logo);
    return (
      <img
        src={src}
        alt=""
        width={size}
        height={size}
        loading="lazy"
        className="shrink-0 rounded-lg bg-panel-2 object-cover ring-1 ring-edge"
        style={{ width: size, height: size }}
        onError={(e) => {
          (e.target as HTMLImageElement).style.display = "none";
        }}
      />
    );
  }
  return (
    <span
      className="mono grid shrink-0 place-items-center rounded-lg bg-panel-2 font-bold text-accent ring-1 ring-edge"
      style={{ width: size, height: size, fontSize: size * 0.32 }}
    >
      {token.symbol.slice(0, 2).toUpperCase()}
    </span>
  );
}
