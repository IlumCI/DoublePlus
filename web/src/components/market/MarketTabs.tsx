export type MarketSort = "mcap" | "vol" | "recent" | "new" | "old";

const TABS: { id: MarketSort; label: string }[] = [
  { id: "mcap", label: "MCAP" },
  { id: "vol", label: "VOL" },
  { id: "recent", label: "RECENT" },
  { id: "new", label: "NEWEST" },
  { id: "old", label: "OLDEST" },
];

export function MarketTabs({ sort, onSort }: { sort: MarketSort; onSort: (s: MarketSort) => void }) {
  return (
    <div className="cpm-tabs" role="tablist" aria-label="Sort markets">
      {TABS.map((t) => (
        <button
          key={t.id}
          role="tab"
          aria-selected={sort === t.id}
          onClick={() => onSort(t.id)}
          className={sort === t.id ? "on" : ""}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}
