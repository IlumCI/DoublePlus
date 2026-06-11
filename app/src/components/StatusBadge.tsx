import type { LaunchStatus } from '../data/launches'

const STYLES: Record<LaunchStatus, { label: string; cls: string; dot?: boolean }> = {
  live: { label: 'Live', cls: 'bg-mint-500/15 text-mint-300 ring-mint-500/40', dot: true },
  upcoming: { label: 'Upcoming', cls: 'bg-amber-glow/10 text-amber-glow ring-amber-glow/30' },
  succeeded: { label: 'Funded', cls: 'bg-mint-500/10 text-mint-400 ring-mint-500/25' },
  failed: { label: 'Refunding', cls: 'bg-rose-soft/10 text-rose-soft ring-rose-soft/30' },
}

export function StatusBadge({ status }: { status: LaunchStatus }) {
  const s = STYLES[status]
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wide ring-1 ${s.cls}`}>
      {s.dot && <span className="h-1.5 w-1.5 rounded-full bg-mint-400 live-dot" />}
      {s.label}
    </span>
  )
}
