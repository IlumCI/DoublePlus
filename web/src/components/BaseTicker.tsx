/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        <g fill="#16a34a">
          <rect x="9.1" y="16" width="1.8" height="13" rx="0.9" />
          <rect x="6.6" y="19" width="6.8" height="8" rx="2" />
          <rect x="19.1" y="11.5" width="1.8" height="15.5" rx="0.9" />
          <rect x="16.6" y="14" width="6.8" height="9.5" rx="2" />
          <rect x="29.1" y="8" width="1.8" height="15" rx="0.9" />
          <rect x="26.6" y="10" width="6.8" height="10.5" rx="2" />
        </g>
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
