export function TokenIcon({
  ticker,
  color,
  size = 38,
}: {
  ticker: string;
  color: string;
  size?: number;
}) {
  return (
    <span
      className="token-icon"
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        fontSize: size * 0.3,
        background: color,
        color: "#090B10",
      }}
    >
      {ticker.slice(0, 2)}
    </span>
  );
}
