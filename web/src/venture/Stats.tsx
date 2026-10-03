import { useMemo } from "react";

import { VENTURE } from "./client";
import { fmtEth } from "./ui";
import { usePageMeta } from "./seo";
import { useVentures } from "./useVentures";
import { env } from "../lib/env";

/** Platform totals, laid out like a Properties sheet: label, value. Every
 *  figure is computed from the coins the board already loaded; the coins
 *  themselves are on the board. */
export function Stats() {
  usePageMeta("Stats");
  const { ventures } = useVentures();

  const t = useMemo(() => {
    const list = ventures ?? [];
    const graduated = list.filter((v) => v.phase === "graduated");
    const failed = list.filter((v) => v.phase === "failed");
    const creatorFee = list.length > 0
      ? list.reduce((a, v) => a + (v.policy.buyTaxBps + v.policy.sellTaxBps) / 2, 0) / list.length / 100
      : 0;
    return {
      count: list.length,
      graduated: graduated.length,
      filling: list.filter((v) => v.phase === "raising" || v.phase === "expired").length,
      failed: failed.length,
      raised: list.reduce((a, v) => a + v.raisedWei, 0n),
      intoPools: graduated.reduce((a, v) => a + v.raisedWei - (v.raisedWei * BigInt(v.founderRaiseBps)) / 10_000n, 0n),
      creatorFee,
    };
  }, [ventures]);

  const rows: [string, string][] = ventures === null ? [] : [
    ["Coins launched", String(t.count)],
    ["Trading on Uniswap", t.count > 0 ? `${t.graduated} (${((t.graduated / t.count) * 100).toFixed(0)}% of launches)` : "0"],
    ["Filling now", String(t.filling)],
    ["Missed their target", String(t.failed)],
    ["ETH paid into curves", `${fmtEth(t.raised, 4)} ETH`],
    ["ETH locked in pools", `${fmtEth(t.intoPools, 4)} ETH`],
    ["Average creator fee", `${t.creatorFee.toFixed(2)}% per trade`],
    ["Platform fee", `${(VENTURE.platformFeeBps / 100).toFixed(2)}% per trade, ${VENTURE.refShareBps / 100}% of that to referrers`],
  ];

  return (
    <div className="dp-shell" style={{ paddingBottom: 70 }}>
      <div className="dp-page-head">
        <h1 className="dp-page-title">Stats</h1>
        <p style={{ maxWidth: "58ch", color: "var(--dim)", fontSize: 13 }}>Read directly from {env.chainName}.</p>
      </div>
      {ventures === null ? <p className="dp-agate">Loading…</p> : (
        <dl className="dp-props">
          {rows.map(([k, v]) => <div key={k}><dt>{k}</dt><dd>{v}</dd></div>)}
        </dl>
      )}
    </div>
  );
}
