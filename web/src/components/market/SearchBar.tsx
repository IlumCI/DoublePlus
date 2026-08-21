export function SearchBar({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="cpm-search-wrap">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
        <circle cx="10.5" cy="10.5" r="6.5" />
        <path d="m16 16 5.5 5.5" />
      </svg>
      <input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search name, ticker, or address"
        type="search"
        className="cpm-search"
        aria-label="Search markets"
      />
    </div>
  );
}
