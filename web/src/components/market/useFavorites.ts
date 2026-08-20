import { useCallback, useState } from "react";

const KEY = "hh:favs";

function load(): Set<string> {
  try {
    return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return new Set();
  }
}

/** Starred tokens, persisted locally. Addresses are stored lowercased. */
export function useFavorites() {
  const [favs, setFavs] = useState<Set<string>>(load);
  const toggle = useCallback((address: string) => {
    setFavs((prev) => {
      const next = new Set(prev);
      const a = address.toLowerCase();
      if (next.has(a)) next.delete(a);
      else next.add(a);
      localStorage.setItem(KEY, JSON.stringify([...next]));
      return next;
    });
  }, []);
  const isFav = useCallback((address: string) => favs.has(address.toLowerCase()), [favs]);
  return { favs, isFav, toggle };
}
