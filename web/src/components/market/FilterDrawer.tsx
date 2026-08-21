import { activeFilterCount, type MarketFilters } from "./util";

export function FilterButton({ count, onClick }: { count: number; onClick: () => void }) {
  return (
    <button type="button" onClick={onClick} className="nb-btn nb-icon" aria-label="Open filters" title="Filters">
      <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden>
        <path d="M3 5h18M6.5 12h11M10 19h4" />
      </svg>
      {count > 0 && (
        <span className="mono" style={{ fontSize: 10, fontWeight: 800, marginLeft: 2 }}>{count}</span>
      )}
    </button>
  );
}

export function FilterDrawer({
  open,
  filters,
  onChange,
  onClose,
}: {
  open: boolean;
  filters: MarketFilters;
  onChange: (f: MarketFilters) => void;
  onClose: () => void;
}) {
  if (!open) return null;
  const set = (patch: Partial<MarketFilters>) => onChange({ ...filters, ...patch });
  return (
    <>
      <div className="nb-scrim" onClick={onClose} aria-hidden />
      <aside className="nb-drawer" role="dialog" aria-label="Market filters">
        <div className="flex items-center justify-between gap-3">
          <h3>Filters</h3>
          <button type="button" onClick={onClose} className="nb-btn nb-icon" aria-label="Close filters">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.4" aria-hidden>
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
          </button>
        </div>

        <label className="nb-check">
          <input type="checkbox" checked={filters.favOnly} onChange={(e) => set({ favOnly: e.target.checked })} />
          Favorites only
        </label>
        <label className="nb-check">
          <input type="checkbox" checked={filters.officialOnly} onChange={(e) => set({ officialOnly: e.target.checked })} />
          Official only
        </label>
        <label className="nb-check">
          <input type="checkbox" checked={filters.hideZeroVol} onChange={(e) => set({ hideZeroVol: e.target.checked })} />
          Hide zero 24h volume
        </label>

        <div className="nb-field">
          <label htmlFor="nbf-liq">Min liquidity (USD)</label>
          <input
            id="nbf-liq"
            type="number"
            min={0}
            value={filters.minLiqUsd || ""}
            placeholder="0"
            onChange={(e) => set({ minLiqUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>
        <div className="nb-field">
          <label htmlFor="nbf-vol">Min 24h volume (USD)</label>
          <input
            id="nbf-vol"
            type="number"
            min={0}
            value={filters.minVolUsd || ""}
            placeholder="0"
            onChange={(e) => set({ minVolUsd: Math.max(0, Number(e.target.value) || 0) })}
          />
        </div>

        <div className="mt-5 flex gap-10" style={{ gap: 10 }}>
          <button
            type="button"
            className="nb-btn"
            onClick={() => onChange({ favOnly: false, officialOnly: false, hideZeroVol: false, minLiqUsd: 0, minVolUsd: 0 })}
            disabled={activeFilterCount(filters) === 0}
          >
            Clear
          </button>
          <button type="button" className="nb-btn on" onClick={onClose} style={{ flex: 1 }}>
            Done
          </button>
        </div>
      </aside>
    </>
  );
}
