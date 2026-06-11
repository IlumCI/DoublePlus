import type { Route } from '../App'

export function Header({ route, onNavigate }: { route: Route; onNavigate: (r: Route) => void }) {
  return (
    <header className="flex items-center justify-between py-5">
      <button
        onClick={() => onNavigate({ page: 'explore' })}
        className="flex cursor-pointer items-center gap-2.5 bg-transparent text-left"
      >
        {/* the logo is a flat line — the whole point */}
        <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-mint-500/15 ring-1 ring-mint-500/40">
          <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
            <path d="M2 13 L16 13" stroke="var(--color-mint-400)" strokeWidth="2.4" strokeLinecap="round" />
            <path d="M2 8 Q7 8 9 5.5 T16 3" stroke="var(--color-fog-500)" strokeWidth="1.4" strokeLinecap="round" strokeDasharray="2 3" opacity="0.7" />
          </svg>
        </span>
        <span>
          <span className="block text-[17px] font-bold leading-tight tracking-tight">Flatline</span>
          <span className="block font-mono text-[10px] uppercase tracking-[0.18em] text-fog-500">HyperEVM launchpad</span>
        </span>
      </button>

      <nav className="hidden items-center gap-1 rounded-full bg-ink-850/80 p-1 ring-1 ring-ink-700 sm:flex">
        {(
          [
            ['Explore', 'explore'],
            ['Create', 'create'],
          ] as const
        ).map(([label, page]) => (
          <button
            key={page}
            onClick={() => onNavigate({ page } as Route)}
            className={`cursor-pointer rounded-full px-4 py-1.5 text-sm font-medium transition-colors ${
              route.page === page ? 'bg-mint-500/15 text-mint-300' : 'text-fog-300 hover:text-fog-100'
            }`}
          >
            {label}
          </button>
        ))}
      </nav>

      <div className="flex items-center gap-3">
        <span className="hidden items-center gap-1.5 font-mono text-xs text-fog-500 md:flex">
          <span className="h-1.5 w-1.5 rounded-full bg-mint-400 live-dot" />
          HyperEVM · 999
        </span>
        <button className="cursor-pointer rounded-xl bg-mint-500 px-4 py-2 text-sm font-semibold text-ink-950 transition hover:bg-mint-400">
          0x3fA8…c21D
        </button>
      </div>
    </header>
  )
}
