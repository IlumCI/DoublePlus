/** Tiny SVG chart kit. No dependency, no canvas — numbers people can see
 *  at a glance instead of sentences they have to read. */

export const SPLIT_COLORS = ["#a5dbb2", "#cba6f7", "#8fb4e3", "#f0c987"];

export interface Slice { label: string; value: number; color?: string; note?: string }

/** Donut with a big number in the middle. The workhorse. */
export function Donut({ slices, size = 148, thickness = 22, center, sub }: {
  slices: Slice[]; size?: number; thickness?: number; center?: string; sub?: string;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  let offset = 0;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img"
      aria-label={slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(", ")}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth={thickness} />
      {slices.map((s, i) => {
        const len = (s.value / total) * circumference;
        const el = (
          <circle key={s.label} cx={c} cy={c} r={r} fill="none"
            stroke={s.color ?? SPLIT_COLORS[i % SPLIT_COLORS.length]} strokeWidth={thickness}
            strokeDasharray={`${len} ${circumference - len}`} strokeDashoffset={-offset}
            transform={`rotate(-90 ${c} ${c})`} />
        );
        offset += len;
        return el;
      })}
      {center && (
        <text x={c} y={sub ? c - 2 : c + 6} textAnchor="middle" fill="var(--text)"
          fontSize={size / 5} fontFamily="var(--mono)">{center}</text>
      )}
      {sub && (
        <text x={c} y={c + 16} textAnchor="middle" fill="var(--faint)" fontSize={size / 12} fontFamily="var(--mono)">{sub}</text>
      )}
    </svg>
  );
}

export function Legend({ slices, unit = "%" }: { slices: Slice[]; unit?: string }) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <ul className="dp-legend">
      {slices.map((s, i) => (
        <li key={s.label}>
          <i style={{ background: s.color ?? SPLIT_COLORS[i % SPLIT_COLORS.length] }} />
          <span>{s.label}{s.note && <em>{s.note}</em>}</span>
          <b>{Math.round((s.value / total) * 100)}{unit}</b>
        </li>
      ))}
    </ul>
  );
}

/** Progress ring for "% to graduation" — a gauge, not a hairline. */
export function Ring({ pct, size = 112, thickness = 12, label }: {
  pct: number; size?: number; thickness?: number; label?: string;
}) {
  const r = (size - thickness) / 2;
  const c = size / 2;
  const circumference = 2 * Math.PI * r;
  const done = Math.max(0, Math.min(100, pct));
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={`${done.toFixed(0)}% funded`}>
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--line)" strokeWidth={thickness} />
      <circle cx={c} cy={c} r={r} fill="none" stroke="var(--up)" strokeWidth={thickness} strokeLinecap="round"
        strokeDasharray={`${(done / 100) * circumference} ${circumference}`}
        transform={`rotate(-90 ${c} ${c})`} />
      <text x={c} y={c + 4} textAnchor="middle" fill="var(--text)" fontSize={size / 3.6} fontFamily="var(--mono)">
        {done.toFixed(0)}%
      </text>
      {label && <text x={c} y={c + 20} textAnchor="middle" fill="var(--faint)" fontSize={size / 11} fontFamily="var(--mono)">{label}</text>}
    </svg>
  );
}

/** Stacked bar for supply or raise allocation. */
export function SplitBar({ slices, height = 14 }: { slices: Slice[]; height?: number }) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="dp-splitbar" style={{ height }} role="img"
      aria-label={slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(", ")}>
      {slices.map((s, i) => (
        <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.color ?? SPLIT_COLORS[i % SPLIT_COLORS.length] }}
          title={`${s.label} ${Math.round((s.value / total) * 100)}%`} />
      ))}
    </div>
  );
}
