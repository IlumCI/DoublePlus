/** Platform-official token addresses (lowercase). The launched COPAIR token
 *  ships as the default; VITE_RH_OFFICIAL (comma-separated) overrides. */
const DEFAULT_OFFICIAL = "0xbdd1b5639548b04fa95bb5f49b5a74a575be7fc3";

export const OFFICIAL_TOKENS: ReadonlySet<string> = new Set(
  String(import.meta.env.VITE_RH_OFFICIAL ?? DEFAULT_OFFICIAL)
    .toLowerCase()
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
);

export const isOfficial = (address: string): boolean => OFFICIAL_TOKENS.has(address.toLowerCase());

/** First (primary) official token, for site-wide links to its market. */
export const PRIMARY_OFFICIAL: string | undefined = [...OFFICIAL_TOKENS][0];

/** The official token's DexScreener page is NOT a constant. It was hardcoded
 *  here as a V4 pool id, which DexScreener has no record of — its API answers
 *  {"pairs":null,"pair":null} for that id, and no pair at all for the token —
 *  so the link went nowhere and nothing referenced it.
 *
 *  A market link can only come from DexScreener's own pair data, since only
 *  they know which pair address they indexed, and whether they indexed one.
 *  Resolve it at the point of use and render nothing when it comes back null:
 *
 *    useDexPairUrl(PRIMARY_OFFICIAL)                       // in a component
 *    PRIMARY_OFFICIAL && fetchDexProfile(PRIMARY_OFFICIAL) // .url is the page
 *
 *  Both live in ./dexscreener. */
