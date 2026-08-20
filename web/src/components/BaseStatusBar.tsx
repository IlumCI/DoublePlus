import { Link } from "react-router-dom";

import { BRAND } from "../lib/brand";
import { env } from "../lib/env";

/** Desktop-only fixed bottom status strip: token status left, quick links right. */
export function BaseStatusBar() {
  return (
    <div className="kf-statusbar">
      <span className="dot" />
      <b>$KOI</b>
      <span className="badge">Not live</span>
      <span className="sp" />
      <span className="up">● {env.chainName}</span>
      <Link to="/">≋ Pools</Link>
      <Link to="/launch">🚀 Launch</Link>
      <a href={BRAND.twitter} target="_blank" rel="noreferrer">𝕏</a>
      <Link to="/docs">Docs</Link>
    </div>
  );
}
