import { compact, hardCapOf, price, type Launch } from '../data/launches'
import { ProgressBar } from './ProgressBar'
import { StatusBadge } from './StatusBadge'

export function LaunchCard({ launch, onOpen, index }: { launch: Launch; onOpen: () => void; index: number }) {
  const hardCap = hardCapOf(launch)
  const pct = Math.min(100, (launch.raised / hardCap) * 100)
  const timeLabel = launch.startsIn
    ? `starts in ${launch.startsIn}`
    : launch.endsIn
      ? `ends in ${launch.endsIn}`
      : `ended ${launch.endedAgo}`

  return (
    <button
      onClick={onOpen}
      className="rise-in group cursor-pointer rounded-2xl bg-ink-850/80 p-5 text-left ring-1 ring-ink-700 backdrop-blur transition hover:-translate-y-0.5 hover:ring-mint-500/50"
      style={{ animationDelay: `${index * 60}ms` }}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 items-center justify-center rounded-xl bg-ink-700 text-xl ring-1 ring-ink-600">
            {launch.emoji}
          </span>
          <div>
            <h3 className="text-[15px] font-bold leading-tight group-hover:text-mint-300">
              {launch.name}
              <span className="ml-1.5 font-mono text-xs font-medium text-fog-500">${launch.symbol}</span>
            </h3>
            <p className="mt-0.5 line-clamp-1 text-[13px] text-fog-300">{launch.tagline}</p>
          </div>
        </div>
        <StatusBadge status={launch.status} />
      </div>

      <div className="mt-5 flex items-baseline justify-between font-mono text-xs text-fog-500">
        <span>
          <span className="text-sm font-semibold text-fog-100">{compact(launch.raised)}</span> / {compact(hardCap)} HYPE
        </span>
        <span className={pct >= 100 ? 'text-mint-400' : ''}>{pct.toFixed(0)}%</span>
      </div>
      <div className="mt-2">
        <ProgressBar launch={launch} />
      </div>

      <div className="mt-4 flex items-center justify-between text-xs text-fog-500">
        <span className="font-mono">
          1 {launch.symbol} = <span className="text-fog-300">{price(launch.priceHype)} HYPE</span>
          <span className="ml-1.5 rounded bg-ink-700 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-mint-400">
            flat
          </span>
        </span>
        <span>{timeLabel}</span>
      </div>
    </button>
  )
}
