import { useEffect, useState } from "react";

import { loadVentures, venturePc, type Venture } from "./client";
import { syncChainClock } from "./clock";

/** One shared, polled copy of the board so the chrome, the activity strip and
 *  every page read the same list instead of each hitting the RPC on its own.
 *  Failures surface: a dead RPC must say so, not spin forever. */
let cache: Venture[] | null = null;
let lastError: string | null = null;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<() => void>();

function emit() { subs.forEach((f) => f()); }

function refreshVentures(): Promise<void> {
  if (inflight) return inflight;
  inflight = Promise.all([loadVentures(), venturePc.getBlock().then((b) => syncChainClock(Number(b.timestamp))).catch(() => undefined)])
    .then(([v]) => { cache = v; lastError = null; })
    .catch((e: unknown) => { lastError = e instanceof Error ? e.message : String(e); })
    .finally(() => { inflight = null; emit(); });
  return inflight;
}

interface BoardState {
  ventures: Venture[] | null;
  error: string | null;
  retry: () => void;
}

export function useVentures(): BoardState {
  const [, bump] = useState(0);
  useEffect(() => {
    const fn = () => bump((n) => n + 1);
    subs.add(fn);
    refreshVentures();
    if (!timer) timer = setInterval(refreshVentures, 15_000);
    return () => {
      subs.delete(fn);
      if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return { ventures: cache, error: cache === null ? lastError : null, retry: () => { refreshVentures(); } };
}
