import { BRAND_FLAVOR } from "../lib/brand";

/**
 * Default token image; a full-bleed branded tile shown for any token without
 * its own logo (or whose logo fails to load). A designed raster mark exported
 * at 512px so it stays sharp from a 12px list avatar up to a full card, served
 * from web/public as a plain <img> with no bundle cost.
 *
 * Flavor-aware: steadypads ships an S-coin mark in the Stable chain's visual
 * language (cream disc sliced by an S on deep forest green); copair ships
 * the faceted feather tile; other flavors keep the quiver tile.
 */
const SRC =
  BRAND_FLAVOR === "steadypads"
    ? "/steadypads-default.png"
    : BRAND_FLAVOR === "arc"
      ? "/steadypads-arc-default.png"
      : BRAND_FLAVOR === "copair"
        ? "/hoodheist-default.png"
        : BRAND_FLAVOR === "base"
          ? "/stonk-logo.jpg"
          : "/quiver-default.png";

export function QuiverMark({ className = "" }: { className?: string }) {
  return (
    <img
      src={SRC}
      alt="Token"
      loading="lazy"
      className={`h-full w-full object-cover ${className}`}
    />
  );
}
