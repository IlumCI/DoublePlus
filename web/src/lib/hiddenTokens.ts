// Tokens hidden from the public Explore feed (test launches, duplicates).
// They stay fully functional by direct address and in the admin console;
// they are only omitted from discovery. Keyed by lowercased address.
export const HIDDEN_TOKENS: ReadonlySet<string> = new Set([
  "0x16ae26dfd4fe18e8f3f0756dca165493b5523a53", // SAFEHOOD (initial test launch)
  "0x55dfcf83135fa4f5d0c3f19311e3d5c103f892c5", // TEST
]);

export function isHidden(address: string): boolean {
  return HIDDEN_TOKENS.has(address.toLowerCase());
}
