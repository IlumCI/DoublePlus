import { useEffect, useState } from "react";

/** Minutes until the next daily payout cycle (UTC midnight). */
function minsToPayout(): number {
  const now = new Date();
  const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.max(1, Math.round((next - now.getTime()) / 60_000));
}

const fmt = (m: number) => (m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m} minutes`);

/**
 * koi.fun marquee ticker — the light countdown band above the header. Counts
 * down to the daily reward payout (UTC midnight), scrolling continuously.
 */
export function BaseTicker() {
  const [mins, setMins] = useState(minsToPayout);
  useEffect(() => {
    const id = setInterval(() => setMins(minsToPayout()), 30_000);
    return () => clearInterval(id);
  }, []);

  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        <path d="M20 3c-6.5 4-9 8.7-9 14.5 0 3.4 1.6 6.2 4.2 7.9-2.9.5-5.2 2.3-6.7 5.1 3.6 4.2 8 6.5 12.8 6.5 3.4 0 6-1.9 6-5 0-2.2-1.3-3.9-3.4-4.7 4.7-1.9 7.6-6 7.6-11.3C31.5 12.8 27.4 6.7 20 3Z" fill="#ff3da6" />
        <circle cx="17.4" cy="15.6" r="2.2" fill="#fff" />
      </svg>
      <b>{fmt(mins)}</b>
      <span>until daily payout</span>
    </span>
  );

  return (
    <div className="kf-ticker" aria-label={`${fmt(mins)} until daily payout`}>
      <div className="kf-ticker-track" aria-hidden>
        {[...Array(8)].map((_, i) => <span key={i} style={{ display: "inline-flex" }}>{item}</span>)}
      </div>
    </div>
  );
}
