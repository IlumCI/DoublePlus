export function Logo({ size = 28 }: { size?: number }) {
  return (
    <span
      className="row"
      style={{ gap: 10, fontWeight: 700, fontSize: "1.08rem", letterSpacing: "-0.03em" }}
    >
      <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="9" fill="#11161D" stroke="rgba(255,255,255,0.1)" />
        <path
          d="M9 22V10l7 8 7-8v12"
          stroke="#22C55E"
          strokeWidth="2.4"
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
      Meridian
    </span>
  );
}
