// Tokens hidden from the public Explore feed (test launches, demo markets,
// duplicates). They stay fully functional by direct address and in the admin
// console; they are only omitted from public discovery. New launches are NOT
// in this list, so they appear on Explore automatically. Keyed by lowercased
// address.
export const HIDDEN_TOKENS: ReadonlySet<string> = new Set([
  "0x16ae26dfd4fe18e8f3f0756dca165493b5523a53", // SAFEHOOD (initial test launch)
  "0x55dfcf83135fa4f5d0c3f19311e3d5c103f892c5", // TEST
  // Pre-launch demo markets — hidden from public discovery until launch.
  "0x25c10aa4614807d41e84427fac0ce7e6ae9e4663", // 4663
  "0x2a2b39e3b645adee02af780be42ffc5741404663", // CHIP
  "0xb44549a596819fd688c5855fede16bee96a24663", // APE
  "0xc031a2e1925c4d6ccfbfc9248ea98d7c798f4663", // MOON
  "0x809b86baa7f7323a9d4cdfa2b1d197cfe42b4663", // GREEN
  "0xa4690fcd485d9c00b6f49592454eaa5d32ed4663", // DIAM
]);

export function isHidden(address: string): boolean {
  return HIDDEN_TOKENS.has(address.toLowerCase());
}
