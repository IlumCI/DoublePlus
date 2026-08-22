/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <img
        src="/stonk-logo.jpg"
        alt=""
        aria-hidden
        style={{ width: 20, height: 20, borderRadius: 6, objectFit: "cover" }}
      />
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
