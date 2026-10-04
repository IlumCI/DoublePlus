import { useState } from "react";
import { Link } from "react-router-dom";

import { usePageMeta } from "./seo";

/** The status code as a cat, from http.cat. Decoration only: if the image
 *  can't load (offline, blocked), it disappears and the notice still reads. */
export function HttpCat({ code }: { code: 404 | 500 | 503 }) {
  const [failed, setFailed] = useState(false);
  if (failed) return null;
  return (
    <img
      src={`https://http.cat/${code}.jpg`}
      alt={`HTTP ${code}`}
      width={750}
      height={600}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      onError={() => setFailed(true)}
      style={{ display: "block", width: "100%", maxWidth: 260, height: "auto", margin: "0 auto 16px", borderRadius: 4 }}
    />
  );
}

/** Any path the site doesn't have. */
export function NotFound() {
  usePageMeta("Not found");
  return (
    <div className="dp-notice" style={{ margin: "40px 18px", textAlign: "center" }}>
      <HttpCat code={404} />
      <h3>Nothing here.</h3>
      <p>This page doesn't exist. Check the link, or start from the list.</p>
      <Link className="dp-action" style={{ display: "inline-block", marginTop: 12 }} to="/" viewTransition>All coins</Link>
    </div>
  );
}
