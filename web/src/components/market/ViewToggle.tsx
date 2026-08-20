export type MarketView = "list" | "grid";

export function ViewToggle({ view, onView }: { view: MarketView; onView: (v: MarketView) => void }) {
  const next = view === "list" ? "grid" : "list";
  return (
    <button
      type="button"
      onClick={() => onView(next)}
      className="nb-btn nb-icon"
      aria-label={`Switch to ${next} view`}
      title={`${next[0].toUpperCase()}${next.slice(1)} view`}
    >
      {view === "list" ? (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
          <rect x="3" y="3" width="8" height="8" /><rect x="13" y="3" width="8" height="8" />
          <rect x="3" y="13" width="8" height="8" /><rect x="13" y="13" width="8" height="8" />
        </svg>
      ) : (
        <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
          <path d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      )}
    </button>
  );
}
