import { useState } from 'react'
import { LAUNCHES, compact, type LaunchStatus } from '../data/launches'
import { LaunchCard } from '../components/LaunchCard'

type Filter = 'all' | LaunchStatus

const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'live', label: 'Live' },
  { key: 'upcoming', label: 'Upcoming' },
  { key: 'succeeded', label: 'Funded' },
  { key: 'failed', label: 'Refunding' },
]

export function Explore({ onOpen, onCreate }: { onOpen: (id: number) => void; onCreate: () => void }) {
  const [filter, setFilter] = useState<Filter>('all')
  const shown = LAUNCHES.filter((l) => filter === 'all' || l.status === filter)
  const totalRaised = LAUNCHES.reduce((s, l) => s + l.raised, 0)
  const liveCount = LAUNCHES.filter((l) => l.status === 'live').length

  return (
    <main>
      {/* hero */}
      <section className="rise-in mt-6 overflow-hidden rounded-3xl bg-ink-900 px-6 py-10 ring-1 ring-ink-700 sm:px-10">
        <p className="font-mono text-xs uppercase tracking-[0.22em] text-mint-400">No bonding curve · ever</p>
        <h1 className="mt-3 max-w-xl text-4xl font-bold leading-[1.05] tracking-tight sm:text-5xl">
          One price.
          <br />
          First buyer to last.
        </h1>
        <p className="mt-4 max-w-lg text-[15px] leading-relaxed text-fog-300">
          Fixed-price token sales on HyperEVM. Miss the soft cap and everyone refunds. Hit it and
          liquidity deploys automatically — LP burned, locked forever.
        </p>
        <div className="mt-7 flex flex-wrap items-center gap-3">
          <button
            onClick={onCreate}
            className="cursor-pointer rounded-xl bg-mint-500 px-5 py-2.5 text-sm font-semibold text-ink-950 transition hover:bg-mint-400"
          >
            Launch a token
          </button>
          <div className="flex items-center gap-5 rounded-xl bg-ink-850 px-4 py-2.5 font-mono text-xs text-fog-500 ring-1 ring-ink-700">
            <span>
              <span className="font-semibold text-fog-100">{compact(totalRaised)}</span> HYPE raised
            </span>
            <span className="h-3 w-px bg-ink-600" />
            <span>
              <span className="font-semibold text-fog-100">{liveCount}</span> live now
            </span>
          </div>
        </div>
      </section>

      {/* filters */}
      <div className="mt-10 flex items-center gap-1.5 overflow-x-auto pb-1">
        {FILTERS.map((f) => (
          <button
            key={f.key}
            onClick={() => setFilter(f.key)}
            className={`cursor-pointer whitespace-nowrap rounded-full px-3.5 py-1.5 text-[13px] font-medium ring-1 transition ${
              filter === f.key
                ? 'bg-mint-500/15 text-mint-300 ring-mint-500/40'
                : 'bg-ink-850/60 text-fog-300 ring-ink-700 hover:text-fog-100'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {shown.map((l, i) => (
          <LaunchCard key={l.id} launch={l} index={i} onOpen={() => onOpen(l.id)} />
        ))}
      </div>
    </main>
  )
}
