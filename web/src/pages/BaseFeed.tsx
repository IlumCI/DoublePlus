import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { TokenLogo } from "../components/TokenLogo";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd, shortAddr, timeAgo } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";
import { volUsd } from "../components/market/util";
import { PREVIEW, PREVIEW_ON } from "../lib/base/preview";

/** Feed — the launch activity stream: every new coin as an activity card. */
export function BaseFeed() {
  const { data: byNew } = useTokens(client, { sort: "new", limit: 50 });

  const list = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    const l = (byNew ?? []).filter((t) => !isHidden(t.address) && !isImpersonator(t));
    return l.length === 0 && PREVIEW_ON ? PREVIEW : l;
  }, [byNew]);

  return (
    <div className="kf kf-page">
      <h1 className="kf-page-h1">Feed</h1>
      <div className="kf-feed">
        {list.map((t) => (
          <Link to={`/token/${t.address}`} key={t.address} className="kf-feed-item">
            <div className="kf-feed-head">
              <TokenLogo token={t} size={38} />
              <b>{t.name} <span style={{ color: "var(--color-ink-3)", fontWeight: 600 }}>· {t.symbol}</span></b>
            </div>
            <p className="kf-feed-line">Launched by {shortAddr(t.creator)} · {timeAgo(t.createdAt)}</p>
            <div className="kf-feed-card">
              <span style={{ color: "var(--color-ink-2)", fontSize: 13.5 }}>Market cap</span>
              <span className="v">{Number(t.marketCapUsd) > 0 ? fmtUsd(t.marketCapUsd) : "—"}</span>
              <span style={{ color: "var(--color-ink-2)", fontSize: 13.5 }}>Volume</span>
              <span className="v">{volUsd(t) > 0 ? fmtUsd(volUsd(t)) : "—"}</span>
            </div>
          </Link>
        ))}
        {list.length === 0 && <div className="kf-empty">No launches yet. Be the first.</div>}
      </div>
    </div>
  );
}
