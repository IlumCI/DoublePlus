/**
 * Quiver default token image — a full-bleed branded tile shown for any token
 * without its own logo (or whose logo fails to load). Pure SVG on a viewBox, so
 * it stays crisp from a 12px list avatar up to a full card. Colors come from the
 * theme tokens, so it tracks light/dark automatically.
 */
export function QuiverMark({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={`h-full w-full ${className}`}
      preserveAspectRatio="xMidYMid slice"
      role="img"
      aria-label="Quiver token"
    >
      <rect width="100" height="100" fill="var(--color-panel-2)" />
      {/* Soft accent glow behind the mark. */}
      <circle cx="50" cy="49" r="33" fill="var(--color-accent)" opacity="0.12" />
      {/* Quiver arrow — an upward arrow (a quiver's arrow, and price going up). */}
      <path
        d="M50 25 L74 51 H60 V71 A6 6 0 0 1 54 77 H46 A6 6 0 0 1 40 71 V51 H26 Z"
        fill="var(--color-accent)"
      />
    </svg>
  );
}
