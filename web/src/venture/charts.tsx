import {
  Cell, Legend as RLegend, Pie, PieChart, PolarAngleAxis, RadialBar, RadialBarChart,
  ResponsiveContainer, Tooltip,
} from "recharts";

/** Chart kit on Recharts: animated donuts, radial gauges and stacked bars,
 *  so the numbers land as pictures instead of sentences. */

export const SPLIT_COLORS = ["#a5dbb2", "#cba6f7", "#8fb4e3", "#f0c987"];

export interface Slice { label: string; value: number; color?: string; note?: string }

const tipStyle = {
  background: "#1d1d2b",
  border: "1px solid #44445c",
  borderRadius: 8,
  fontFamily: "var(--mono)",
  fontSize: 12,
  color: "#ece4d0",
  padding: "6px 10px",
};

/** Donut with a big number in the middle. The workhorse. */
export function Donut({ slices, size = 152, thickness = 24, center, sub, animate = true }: {
  slices: Slice[]; size?: number; thickness?: number; center?: string; sub?: string;
  /** Off for donuts wired to a slider: a re-animation on every input event
   *  restarts before it finishes and the ring reads as one flat colour. */
  animate?: boolean;
}) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  // Colour by the slice's own position, then drop the empties: filtering first
  // would shift every colour and desync the donut from its legend.
  const data = slices
    .map((s, i) => ({ name: s.label, value: s.value, fill: s.color ?? SPLIT_COLORS[i % SPLIT_COLORS.length] }))
    .filter((s) => s.value > 0);
  const outer = size / 2;
  const inner = outer - thickness;
  return (
    <div style={{ width: size, height: size, position: "relative", flex: `0 0 ${size}px` }}>
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Pie data={data} dataKey="value" nameKey="name" cx="50%" cy="50%"
            innerRadius={inner} outerRadius={outer} paddingAngle={2} stroke="none"
            startAngle={90} endAngle={-270}
            isAnimationActive={animate} animationDuration={450}>
            {data.map((d) => <Cell key={d.name} fill={d.fill} />)}
          </Pie>
          <Tooltip contentStyle={tipStyle} itemStyle={{ color: "#ece4d0" }}
            formatter={(value: number, name: string) => [`${Math.round((value / total) * 100)}%`, name]} />
        </PieChart>
      </ResponsiveContainer>
      {(center || sub) && (
        <div style={{
          position: "absolute", inset: 0, display: "grid", placeContent: "center",
          textAlign: "center", pointerEvents: "none",
        }}>
          {center && <span style={{ fontFamily: "var(--mono)", fontSize: size / 5, color: "var(--text)", lineHeight: 1 }}>{center}</span>}
          {sub && <span style={{ fontFamily: "var(--mono)", fontSize: size / 13, color: "var(--faint)", marginTop: 4 }}>{sub}</span>}
        </div>
      )}
    </div>
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

/** Radial gauge for "% to graduation". */
export function Ring({ pct, size = 132, label }: { pct: number; size?: number; label?: string }) {
  const done = Math.max(0, Math.min(100, pct));
  const data = [{ name: "funded", value: done, fill: "#a5dbb2" }];
  return (
    <div style={{ width: size, height: size, position: "relative", flex: `0 0 ${size}px` }}>
      <ResponsiveContainer width="100%" height="100%">
        <RadialBarChart innerRadius="72%" outerRadius="100%" data={data}
          startAngle={90} endAngle={-270} barSize={13}>
          <PolarAngleAxis type="number" domain={[0, 100]} angleAxisId={0} tick={false} />
          <RadialBar background={{ fill: "#303044" }} dataKey="value" cornerRadius={7}
            angleAxisId={0} animationDuration={600} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div style={{ position: "absolute", inset: 0, display: "grid", placeContent: "center", textAlign: "center", pointerEvents: "none" }}>
        <span style={{ fontFamily: "var(--mono)", fontSize: size / 3.8, color: "var(--text)", lineHeight: 1 }}>{done.toFixed(0)}%</span>
        {label && <span style={{ fontFamily: "var(--mono)", fontSize: size / 12, color: "var(--faint)", marginTop: 3 }}>{label}</span>}
      </div>
    </div>
  );
}

/** Stacked bar for supply or raise allocation. */
export function SplitBar({ slices, height = 16 }: { slices: Slice[]; height?: number }) {
  const total = slices.reduce((a, s) => a + s.value, 0) || 1;
  return (
    <div className="dp-splitbar" style={{ height }} role="img"
      aria-label={slices.map((s) => `${s.label} ${Math.round((s.value / total) * 100)}%`).join(", ")}>
      {slices
        .map((s, i) => ({ ...s, fill: s.color ?? SPLIT_COLORS[i % SPLIT_COLORS.length] }))
        .filter((s) => s.value > 0)
        .map((s) => (
          <span key={s.label} style={{ width: `${(s.value / total) * 100}%`, background: s.fill }}
            title={`${s.label} ${Math.round((s.value / total) * 100)}%`} />
        ))}
    </div>
  );
}

export { RLegend };
