import { useState } from "react";

import { stockLogo } from "../lib/v4/stocks";

/** A stock's logo, falling back to its ticker initials if the image fails. */
export function StockLogo({ symbol, size = 20, className = "" }: { symbol: string; size?: number; className?: string }) {
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
      src={stockLogo(symbol)}
      alt={symbol}
      loading="lazy"
      onError={() => setFailed(true)}
      className={`shrink-0 rounded-full bg-white object-contain ${className}`}
      style={{ height: size, width: size }}
    />
  );
}
