/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        <path d="M20 3c-6.5 4-9 8.7-9 14.5 0 3.4 1.6 6.2 4.2 7.9-2.9.5-5.2 2.3-6.7 5.1 3.6 4.2 8 6.5 12.8 6.5 3.4 0 6-1.9 6-5 0-2.2-1.3-3.9-3.4-4.7 4.7-1.9 7.6-6 7.6-11.3C31.5 12.8 27.4 6.7 20 3Z" fill="#ff3da6" />
        <circle cx="17.4" cy="15.6" r="2.2" fill="#fff" />
      </svg>
      <b>Hold &amp; earn</b>
      <span>rewards stream to holders in real time</span>
    </span>
  );

  return (
    <div className="kf-ticker" aria-label="Rewards stream to holders in real time">
      <div className="kf-ticker-track" aria-hidden>
        {[...Array(8)].map((_, i) => <span key={i} style={{ display: "inline-flex" }}>{item}</span>)}
      </div>
    </div>
  );
}
