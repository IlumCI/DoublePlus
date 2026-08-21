/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        <path d="M9 27 L17 19 L22 24 L31 13" stroke="#16a34a" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
        <path d="M31 13 L31 20 M31 13 L24 13" stroke="#16a34a" strokeWidth="3.4" strokeLinecap="round" strokeLinejoin="round" />
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
