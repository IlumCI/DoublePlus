export function FavoriteButton({
  on,
  onToggle,
  size = 17,
}: {
  on: boolean;
  onToggle: () => void;
  size?: number;
}) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onToggle();
      }}
      className={`nb-star ${on ? "on" : ""}`}
      aria-label={on ? "Remove from favorites" : "Add to favorites"}
      aria-pressed={on}
    >
      <svg width={size} height={size} viewBox="0 0 24 24" fill={on ? "currentColor" : "none"} stroke="currentColor" strokeWidth="2.4" aria-hidden>
        <path d="m12 2.8 2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.6l6.5-.9z" strokeLinejoin="miter" />
      </svg>
    </button>
  );
}
