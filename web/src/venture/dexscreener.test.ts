import { describe, expect, it } from "vitest";

import { classifyDexProfile, hasProfileData, profileLinks, type DexOrder, type DexPair } from "./dexscreener";

/** The `info` block DEX Screener actually returned for PONS on Robinhood
 *  Chain — a token whose profile is paid for. Kept verbatim so the classifier
 *  is tested against the real shape, not an idealised one. */
const PAID_INFO = {
  imageUrl: "https://cdn.dexscreener.com/cms/images/dkmXs8KYMyMXjuU1?width=800&height=800",
  header: "https://cdn.dexscreener.com/cms/images/6IKrI-WtX92dxhL0?width=1500&height=500",
  openGraph: "https://cdn.dexscreener.com/token-images/og/robinhood/0x39dbed?timestamp=1789670400000",
  websites: [{ url: "https://ponsfamily.com/launchpad", label: "Website" }],
  socials: [{ url: "https://x.com/ponsdotfamily", type: "twitter" }],
};

/** The order feed for the same token: an approved profile purchase next to a
 *  cancelled community takeover. The cancelled row must not count. */
const PONS_ORDERS: DexOrder[] = [
  { type: "communityTakeover", status: "cancelled", paymentTimestamp: 1_784_358_321_589 },
  { type: "tokenProfile", status: "approved", paymentTimestamp: 1_783_977_792_564 },
];

const pair = (over: Partial<DexPair> = {}): DexPair => ({
  chainId: "robinhood",
  url: "https://dexscreener.com/robinhood/0x10cc",
  pairAddress: "0x10cc",
  liquidity: { usd: 6_442_744 },
  ...over,
});

describe("hasProfileData", () => {
  it("counts the fields a payment unlocks", () => {
    expect(hasProfileData(PAID_INFO)).toBe(true);
    expect(hasProfileData({ header: "https://x/h.png" })).toBe(true);
    expect(hasProfileData({ socials: [{ url: "https://t.me/x", type: "telegram" }] })).toBe(true);
  });

  it("ignores openGraph, which DEX Screener templates for every token", () => {
    // Counting this would mark every listed token as paid.
    expect(hasProfileData({ openGraph: PAID_INFO.openGraph })).toBe(false);
    expect(hasProfileData({ websites: [], socials: [] })).toBe(false);
    expect(hasProfileData(null)).toBe(false);
    expect(hasProfileData(undefined)).toBe(false);
  });
});

describe("classifyDexProfile", () => {
  it("reads an approved tokenProfile order as paid, with its payment date", () => {
    const p = classifyDexProfile(PONS_ORDERS, [pair({ info: PAID_INFO })]);
    expect(p.state).toBe("paid");
    expect(p.via).toBe("order");
    expect(p.paidAt).toBe(1_783_977_792_564);
    expect(p.info).toEqual(PAID_INFO);
  });

  it("does not read a cancelled order as payment", () => {
    const p = classifyDexProfile([{ type: "tokenProfile", status: "cancelled", paymentTimestamp: 1 }], [pair()]);
    expect(p.state).toBe("unpaid");
    expect(p.paidAt).toBeNull();
  });

  it("does not let a non-profile order buy the badge", () => {
    // A boost or an ad is a different product and says nothing about token info.
    const p = classifyDexProfile([{ type: "tokenAd", status: "approved", paymentTimestamp: 9 }], [pair()]);
    expect(p.state).toBe("unpaid");
  });

  it("treats held profile content as payment when the order feed is silent", () => {
    // The bulk endpoint returns no orders at all, so this is the only route
    // by which the board can tell paid from unpaid.
    const p = classifyDexProfile([], [pair({ info: PAID_INFO })]);
    expect(p.state).toBe("paid");
    expect(p.via).toBe("profile-data");
    expect(p.paidAt).toBeNull();
  });

  it("marks an order awaiting approval as pending, not paid", () => {
    const p = classifyDexProfile([{ type: "tokenProfile", status: "processing" }], [pair()]);
    expect(p.state).toBe("pending");
  });

  it("separates a token with no pair from a token with an unpaid pair", () => {
    // A venture still on the curve has nothing indexed; calling that "unpaid"
    // would blame every honest raise for a payment it cannot yet make.
    expect(classifyDexProfile([], []).state).toBe("unlisted");
    expect(classifyDexProfile([], [pair()]).state).toBe("unpaid");
  });

  it("links the deepest pool, because that is the page people trade on", () => {
    const p = classifyDexProfile([], [
      pair({ url: "https://dexscreener.com/robinhood/shallow", liquidity: { usd: 1_500 } }),
      pair({ url: "https://dexscreener.com/robinhood/deep", liquidity: { usd: 6_000_000 }, info: PAID_INFO }),
    ]);
    expect(p.url).toBe("https://dexscreener.com/robinhood/deep");
    expect(p.pairs).toBe(2);
  });

  it("survives pairs that report no liquidity at all", () => {
    const p = classifyDexProfile([], [pair({ liquidity: undefined }), pair({ liquidity: undefined })]);
    expect(p.state).toBe("unpaid");
    expect(p.url).toBe("https://dexscreener.com/robinhood/0x10cc");
  });
});

describe("profileLinks", () => {
  it("labels the profile's links the way the rest of the site does", () => {
    expect(profileLinks(PAID_INFO)).toEqual([
      { label: "Website", url: "https://ponsfamily.com/launchpad" },
      { label: "X", url: "https://x.com/ponsdotfamily" },
    ]);
  });

  it("drops duplicates and anything that is not an http URL", () => {
    const links = profileLinks({
      websites: [{ url: "https://a.io/" }, { url: "https://a.io" }, { url: "javascript:alert(1)" }],
      socials: [{ url: "https://t.me/x", type: "telegram" }],
    });
    expect(links).toEqual([
      { label: "Website", url: "https://a.io/" },
      { label: "Telegram", url: "https://t.me/x" },
    ]);
  });

  it("returns nothing when there is no profile", () => {
    expect(profileLinks(null)).toEqual([]);
  });
});

describe("bulk truncation", () => {
  it("reports a starved token as unknown, never as unlisted", () => {
    // The bulk endpoint caps its response at 30 pairs across all requested
    // tokens, so a token with no pairs in a saturated response may simply
    // have been crowded out. Saying "unlisted" there is a false negative.
    expect(classifyDexProfile([], [], true).state).toBe("unknown");
    expect(classifyDexProfile([], [], false).state).toBe("unlisted");
  });

  it("still classifies a token that did get pairs in a saturated response", () => {
    expect(classifyDexProfile([], [pair({ info: PAID_INFO })], true).state).toBe("paid");
    expect(classifyDexProfile([], [pair()], true).state).toBe("unpaid");
  });
});
