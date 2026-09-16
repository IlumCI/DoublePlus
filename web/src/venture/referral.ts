import type { Address } from "viem";

const KEY = "venture.ref";

/** Capture ?ref=0x… from any landing URL; first referrer sticks until bound. */
export function captureRef() {
  try {
    const ref = new URLSearchParams(location.search).get("ref");
    if (ref && /^0x[0-9a-fA-F]{40}$/.test(ref) && !localStorage.getItem(KEY)) {
      localStorage.setItem(KEY, ref);
    }
  } catch {
    /* storage unavailable */
  }
}

export function storedRef(): Address | null {
  try {
    const v = localStorage.getItem(KEY);
    return v && /^0x[0-9a-fA-F]{40}$/.test(v) ? (v as Address) : null;
  } catch {
    return null;
  }
}

export function clearStoredRef() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
}

/** The share link for the current page, crediting `me`. */
export function refLink(me: Address): string {
  const url = new URL(location.href);
  url.searchParams.set("ref", me);
  return url.toString();
}
