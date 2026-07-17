import { useState } from "react";

import { stockLogo } from "../lib/v4/stocks";

/** A stock's official Robinhood logo, falling back to its ticker initials. */
export function StockLogo({ address, symbol, size = 20, className = "" }: { address: string; symbol: string; size?: number; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <span
        className={`grid shrink-0 place-items-center rounded-full bg-panel-2 font-bold text-ink-3 ${className}`}
        style={{ height: size, width: size, fontSize: size * 0.4 }}
      >
        {symbol.slice(0, 2)}
      </span>
    );
  }
  return (
    <img
      src={stockLogo(address)}
      alt={symbol}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full object-cover ${className}`}
      style={{ height: size, width: size }}
    />
  );
}
