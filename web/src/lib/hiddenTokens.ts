import { env } from "./env";

// Tokens hidden from the public Explore feed (test launches, demo markets,
// duplicates). They stay fully functional by direct address and in the admin
// console; they are only omitted from public discovery. New launches are NOT
// in this list, so they appear on Explore automatically.
//
// Entries are keyed by `${chainId}:${lowercased address}`. Chain scoping is
// load-bearing: the factory deploys tokens at deterministic addresses, so the
// same address can exist on two chains as two different tokens (hiding the
// old Stable STEADY silently hid the first Robinhood launch too).
const HIDDEN_TOKENS: ReadonlySet<string> = new Set([
  // Robinhood Chain (4663), Hood factory: superseded official launches
  "4663:0x9e73a554968a9b3b69ab71f6ef43ca7f3720518b", // COPAIR (pre-toebeans official)
  "4663:0x5fcb2390cb05d92e3e29e892c606cda027ec0259", // BEANS (deployer launch; the user relaunches the official)
  "4663:0x077d721af9221dbaa5c953b9f5086df48bd57d3c", // TBS (first official attempt, superseded)
  "4663:0xbe5fcc1b19de2d32777803b6ae13868bba04d57e", // BEANS (second official attempt, superseded by 0xbF54)
  "4663:0xeb89c4f0875b46b60aa4bf5337e11dd979a927d4", // TOE (impersonates the official brand)
  "4663:0xbf54eddf462656706c7d17866fe170bd0b595f7a", // BEANS (toebeans-era official, superseded by UHOOD 0x4aBc)
  "4663:0x2e77fc1860c1e29536fc40cf5e1b53a1704c358c", // KB / Killer Bean (toebeans-era launch)
  "4663:0x704346b2fade7eae26f96984713871a26d8d8ee7", // BEAGO (toebeans-era launch)
  // Robinhood Chain (4663), quiverpad V4 era
  "4663:0x16ae26dfd4fe18e8f3f0756dca165493b5523a53", // SAFEHOOD (initial test launch)
  "4663:0x55dfcf83135fa4f5d0c3f19311e3d5c103f892c5", // TEST
  "4663:0x2a2b39e3b645adee02af780be42ffc5741404663", // CHIP (pre-launch demo)
  "4663:0xb44549a596819fd688c5855fede16bee96a24663", // APE (pre-launch demo)
  "4663:0xc031a2e1925c4d6ccfbfc9248ea98d7c798f4663", // MOON (pre-launch demo)
  "4663:0x809b86baa7f7323a9d4cdfa2b1d197cfe42b4663", // GREEN (pre-launch demo)
  "4663:0xa4690fcd485d9c00b6f49592454eaa5d32ed4663", // DIAM (pre-launch demo)
  // RhFactory fork: early test launches mis-sized to a $1 pair price (replaced
  // by correctly-priced relaunches PPRINT2/CCPRINT2).
  "4663:0x78238f1d6cb47f9d1fa6cc51c9a6dcabb6ea4663", // PPRINT (wrong start price)
  "4663:0xf6dfe56d943dc4001600896130b6ee76fb304663", // CCPRINT (wrong start price)
  // Flywheel factory: uhood-era official superseded by the hoodheist rebrand;
  // hidden until the official $HEIST launch.
  "4663:0x5cc5d708116e9b63bbca1aa670536fd210fa76ef", // UHOOD (pre-rebrand official)
  // Only the official HEIST (0xbdD1b563...) stays visible at launch; these
  // copycat launches impersonate the brand.
  "4663:0xb65085b3eaffeb08f3e7851886b0d5f3ab6d7c49", // HOODHEIST (impersonator)
  "4663:0x7c10f0af7a835a1cda2421053c79592574a911be", // HEIST (impersonator)
  // Stable Mainnet (988), steadypads validation launches
  "988:0x785c693d9efe13d88a5e566515258f4d2b093f11", // STEADY (validation launch)
  "988:0x854088037076ec7d3c41c1737513ebab3b46521f", // TEST
  "988:0xb90f8bd06c9d935173b50f95e807ed6572e906e3", // STEADY (official relaunch)
  // Arc mainnet (5042): nothing hidden. The old TEST/CHECK entries lived on
  // retired factories the current site does not read, and CHECKV3 stays
  // visible until the official launch settles.
  // Base (8453), StockFlyFactoryV3: keeper/lifecycle validation launches. New
  // launches by anyone are NOT listed here, so they appear on Explore normally.
  "8453:0xb20000000000000000000002da484bdfa643272a", // KOIT (test launch)
  "8453:0xb20000000000000000000041e15f9275f02f383c", // KOIT (test launch)
]);

export function isHidden(address: string): boolean {
  return HIDDEN_TOKENS.has(`${env.chainId}:${address.toLowerCase()}`);
}

// The one address allowed to wear the brand. Kept in sync with official.ts.
const OFFICIAL_HEIST = "0xbdd1b5639548b04fa95bb5f49b5a74a575be7fc3";

/** Auto-hide launches that impersonate the platform brand (name or ticker
 *  reads as hoodheist/HEIST) unless they are the official token. New fakes
 *  disappear without a manual list entry; everything else shows freely. */
export function isImpersonator(t: { address: string; name?: string; symbol?: string }): boolean {
  if (t.address.toLowerCase() === OFFICIAL_HEIST) return false;
  const s = `${t.name ?? ""} ${t.symbol ?? ""}`.toLowerCase();
  return /hood\s*heist|heist|hoodhiest|h[e3]ist/.test(s.replace(/[^a-z0-9 ]/g, ""));
}
