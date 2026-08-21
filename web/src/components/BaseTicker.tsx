/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        {/* stonks meme man */}
        <rect x="2" y="2" width="36" height="36" rx="10" fill="#0f1113" />
        <g transform="translate(4 4) scale(0.8)">
          <path d="M6 40 V34.7 C6 30.3 11 27.7 20 27.7 C29 27.7 34 30.3 34 34.7 V40 Z" fill="#c9cdd2" />
          <path d="M16 27.7 L20 36 L24 27.7 Z" fill="#0f1113" />
          <path d="M20 35 L18.3 29 H21.7 Z" fill="#22c55e" />
          <rect x="17.4" y="23" width="5.2" height="6" rx="2" fill="#c9cdd2" />
          <ellipse cx="9.8" cy="14" rx="1.8" ry="2.8" fill="#c9cdd2" /><ellipse cx="30.2" cy="14" rx="1.8" ry="2.8" fill="#c9cdd2" />
          <path d="M20 2.4 C13 2.4 10 8 10 14.7 C10 22 14.3 26 20 26 C25.7 26 30 22 30 14.7 C30 8 27 2.4 20 2.4 Z" fill="#c9cdd2" />
          <ellipse cx="17.3" cy="14" rx="1.05" ry="1.4" fill="#2b2f36" /><ellipse cx="23.3" cy="14" rx="1.05" ry="1.4" fill="#2b2f36" />
          <path d="M20 14.3 C19.3 17 18.6 18.3 18 19 C18.7 19.7 20.3 19.7 21 19" stroke="#2b2f36" strokeWidth="0.8" fill="none" strokeLinecap="round" opacity="0.7" />
          <path d="M17.6 21.7 H22.4" stroke="#2b2f36" strokeWidth="0.9" strokeLinecap="round" opacity="0.7" />
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
