import { useEffect } from "react";

import { BRAND } from "../lib/brand";

/** Per-route title and description. Link previews for individual projects
 *  still need prerendering at the edge — a client-side SPA cannot serve
 *  crawler-visible per-token tags. Site-level cards are injected at build. */
export function usePageMeta(title: string | null, description?: string) {
  useEffect(() => {
    document.title = title ? `${title} · ${BRAND.name}${BRAND.tld}` : BRAND.title;
    if (description) {
      document.querySelector('meta[name="description"]')?.setAttribute("content", description);
    }
    return () => { document.title = BRAND.title; };
  }, [title, description]);
}
