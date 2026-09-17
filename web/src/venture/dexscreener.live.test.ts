/** Live contract check against DEX Screener's API. Excluded from `npm test`
 *  because it needs the network; run it with `npm run test:live` when their
 *  API or the chain's indexing changes. It pins the three facts the feature
 *  rests on: the Robinhood Chain slug, that an approved `tokenProfile` order
 *  is visible on this chain, and that the 30-pair response cap cannot starve
 *  a token out of a bulk read. */
import { describe, expect, it } from "vitest";
import { clearDexCache, fetchDexProfile, fetchDexProfiles, DEX_CHAIN } from "./dexscreener";

const PONS = "0x39dBED3a2bd333467115dE45665cC57F813C4571";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NONE = "0x000000000000000000000000000000000000dEaD";

describe("live dexscreener", () => {
  it("resolves the real chain slug", () => { expect(DEX_CHAIN).toBe("robinhood"); });

  it("classifies PONS as paid from the live order feed", async () => {
    clearDexCache();
    const p = await fetchDexProfile(PONS);
    console.log("PONS single:", JSON.stringify({ ...p, info: p.info ? Object.keys(p.info) : null }));
    expect(p.state).toBe("paid");
    expect(p.via).toBe("order");
    expect(p.url).toMatch(/^https:\/\/dexscreener\.com\/robinhood\//);
    expect(p.info?.header).toBeTruthy();
  }, 30_000);

  it("caches: the second call does not refetch", async () => {
    const a = await fetchDexProfile(PONS);
    const b = await fetchDexProfile(PONS);
    expect(b).toBe(a);
  }, 30_000);

  it("bulk-classifies a mixed batch without the order feed", async () => {
    clearDexCache();
    const m = await fetchDexProfiles([PONS, WETH, NONE]);
    for (const [k, v] of m) console.log("bulk", k, v.state, v.via, v.pairs);
    expect(m.get(PONS.toLowerCase())?.state).toBe("paid");
    expect(m.get(PONS.toLowerCase())?.via).toBe("profile-data");
    // PONS saturates the 30-pair response cap, so this only resolves because
    // the second pass re-reads the starved address on its own.
    expect(m.get(NONE.toLowerCase())?.state).toBe("unlisted");
  }, 30_000);
});
