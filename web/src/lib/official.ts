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

/** DexScreener market page for the primary official token's pool. */
export const OFFICIAL_DEXSCREENER =
  "https://dexscreener.com/robinhood/0x331f09547a956f4153ddf5ac5fef5b68c62be6342f2e1ed593de7d46c5455034";
