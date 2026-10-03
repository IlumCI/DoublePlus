/**
 * Imported first, before any wallet code. In strict privacy modes (cookies
 * blocked, some embedded browsers) merely reading window.localStorage throws,
 * and WalletConnect's storage polyfill reads it at import time, so the whole
 * bundle failed and the site rendered blank. When storage is unusable this
 * installs an in-memory Storage in its place: everything works, nothing is
 * remembered across visits.
 */
class MemoryStorage implements Storage {
  private m = new Map<string, string>();
  get length() { return this.m.size; }
  clear() { this.m.clear(); }
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  key(i: number) { return [...this.m.keys()][i] ?? null; }
  removeItem(k: string) { this.m.delete(k); }
  setItem(k: string, v: string) { this.m.set(k, String(v)); }
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  let usable = false;
  try {
    const s = window[name];
    const probe = "__dp_probe__";
    s.setItem(probe, "1");
    s.removeItem(probe);
    usable = true;
  } catch { /* blocked, throwing or full */ }
  if (!usable) {
    try {
      Object.defineProperty(window, name, { value: new MemoryStorage(), configurable: true, writable: false });
    } catch { /* not redefinable: nothing more we can do */ }
  }
}

export {};
