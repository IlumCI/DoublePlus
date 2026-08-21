// Curated logo overrides for official tokens, keyed by lowercased address.
// On-chain metadata is immutable at launch, so this registry can force a
// brand mark for a known address. Empty by default: tokens use the logo
// their creator set at launch.
export const OFFICIAL_LOGOS: Record<string, string> = {
  // $STEADY (Robinhood Chain): launched with a 96px on-chain thumbnail before
  // the 256px pipeline landed; serve the hi-res frog instead.
  "0xa3c4358484a1f90cd9b43b1b445264390d66ceaa": "/steady-frog.png",
  // $HEIST official: the hooded mascot, served crisp from this origin.
  "0xbdd1b5639548b04fa95bb5f49b5a74a575be7fc3": "/hoodheist-pfp.png",
};
