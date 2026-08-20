import { useCountUp, useInView } from "../lib/hooks";

export function AnimatedNumber({
  value,
  format,
  duration = 1100,
}: {
  value: number;
  format: (v: number) => string;
  duration?: number;
}) {
  const { ref, inView } = useInView<HTMLSpanElement>(0.3);
  const display = useCountUp(value, duration, inView);
  return (
    <span ref={ref} className="tnum">
      {format(inView ? display : 0)}
    </span>
  );
}
