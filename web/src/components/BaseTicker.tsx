/**
 * koi.fun marquee ticker — the light band above the header. Rewards stream to
 * holders in real time (no daily cycle), so the band carries that message,
 * scrolling continuously, rather than a countdown.
 */
export function BaseTicker() {
  const item = (
    <span className="kf-tick">
      <svg viewBox="0 0 40 40" fill="none" aria-hidden>
        {/* derpy meme man in a Base hoodie */}
        <rect x="2" y="2" width="36" height="36" rx="10" fill="#0f1113" />
        <g transform="scale(0.3333)">
          <path d="M4 120 V102 C4 88 22 80 60 80 C98 80 116 88 116 102 V120 Z" fill="#0052FF" />
          <path d="M60 82 L52 120 H68 Z" fill="#0040cc" />
          <g transform="translate(60 104)"><circle r="8" fill="#fff" /><path d="M4 -8 A8 8 0 1 0 4 8 Z" fill="#0052FF" /></g>
          <path d="M16 54 C16 20 34 6 60 6 C86 6 104 20 104 54 C104 74 92 86 74 90 L46 90 C28 86 16 74 16 54 Z" fill="#0052FF" />
          <rect x="47" y="84" width="3" height="26" rx="1.5" fill="#eef1f5" />
          <rect x="70" y="84" width="3" height="22" rx="1.5" fill="#eef1f5" />
          <circle cx="48.5" cy="112" r="2.6" fill="#eef1f5" /><circle cx="71.5" cy="108" r="2.6" fill="#eef1f5" />
          <ellipse cx="30" cy="50" rx="5" ry="7.5" fill="#c9cdd2" /><ellipse cx="90" cy="50" rx="5" ry="7.5" fill="#c9cdd2" />
          <path d="M60 18 C40 18 31 32 31 50 C31 70 44 82 60 82 C76 82 89 70 89 50 C89 32 80 18 60 18 Z" fill="#c9cdd2" />
          <circle cx="50" cy="48" r="6" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="53" cy="50" r="2.4" fill="#20242b" />
          <circle cx="72" cy="46" r="5" fill="#fff" stroke="#20242b" strokeWidth="1.5" /><circle cx="69" cy="48" r="2" fill="#20242b" />
          <path d="M58 56 C56 62 55 65 53 67 C56 69 61 69 63 67" stroke="#20242b" strokeWidth="2" fill="none" strokeLinecap="round" opacity="0.7" />
          <path d="M50 72 Q57 78 64 72" stroke="#20242b" strokeWidth="2.4" fill="none" strokeLinecap="round" />
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
