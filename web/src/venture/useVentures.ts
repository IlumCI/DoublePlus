import { useEffect, useState } from "react";

import { loadVentures, type Venture } from "./client";

/** One shared, polled copy of the board so the chrome, the ticker and every
 *  page read the same list instead of each hitting the RPC on its own. */
let cache: Venture[] | null = null;
let inflight: Promise<void> | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
const subs = new Set<(v: Venture[] | null) => void>();

function refresh() {
  if (inflight) return inflight;
  inflight = loadVentures()
    .then((v) => { cache = v; subs.forEach((f) => f(v)); })
    .catch(() => undefined)
    .finally(() => { inflight = null; });
  return inflight;
}

export function useVentures(): Venture[] | null {
  const [list, setList] = useState<Venture[] | null>(cache);
  useEffect(() => {
    subs.add(setList);
    if (cache) setList(cache);
    refresh();
    if (!timer) timer = setInterval(refresh, 15_000);
    return () => {
      subs.delete(setList);
      if (subs.size === 0 && timer) { clearInterval(timer); timer = null; }
    };
  }, []);
  return list;
}
