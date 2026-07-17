/**
 * Quiver default token image — a full-bleed branded tile shown for any token
 * without its own logo (or whose logo fails to load). A designed raster mark: a
 * lime quiver (archer's case) with arrows on the dark panel, exported at 512px
 * so it stays sharp from a 12px list avatar up to a full card. Served from
 * /quiver-default.png (web/public), so it's a plain <img> with no bundle cost.
 */
export function QuiverMark({ className = "" }: { className?: string }) {
  return (
    <img
      src="/quiver-default.png"
      alt="Quiver token"
      loading="lazy"
      className={`h-full w-full object-cover ${className}`}
    />
  );
}
