import { useMemo } from "react";
import { useTokens } from "@launchpad/sdk/react";
import type { TokenSummary } from "@launchpad/sdk";

import { FlywheelPanel } from "../components/FlywheelPanel";
import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd, usdRateOf } from "../lib/format";
import { isHidden, isImpersonator } from "../lib/hiddenTokens";

/** The flywheel dashboard: live burn pot, countdown, top-3 leaderboard, and
 *  platform-wide stats. The board itself stays a clean token grid. */
export function FlywheelPage() {
  const { data: byVolume } = useTokens(client, { sort: "volume", limit: 80 });
  const all = useMemo(() => {
    if (env.hideTokens) return [] as TokenSummary[];
    return (byVolume ?? []).filter((t) => !isHidden(t.address) && !isImpersonator(t));
  }, [byVolume]);

  const dayVolumeUsd = useMemo(
    () => all.reduce((a, t) => a + (Number(t.volume24hWei || "0") / 1e18) * usdRateOf(t), 0),
    [all],
  );

  return (
    <div className="cpm">
      <section className="cpm-hero" style={{ paddingBottom: 8 }}>
        <h1 className="cpm-headline" style={{ fontSize: "clamp(30px, 5vw, 44px)" }}>
          The flywheel
        </h1>
        <p className="cpm-sub">
          A flat 1% fee on every trade. 25% buys back and burns the week's top 3 coins by
          volume. 30% flows back to traders in ETH, claimable weekly on your Profile. 20% pays
          the deployer for the life of the coin, and 25% runs the platform. Snipers pay extra,
          straight into the burn.
        </p>
        <p className="cpm-statline">
          {all.length} markets · {fmtUsd(dayVolumeUsd)} 24h volume
        </p>
      </section>

      <FlywheelPanel tokens={all} ethUsd={all.length ? usdRateOf(all[0]) : 0} />

      <section className="fly-facts">
        <div className="fly-fact">
          <b>Every trade counts</b>
          <p>
            Volume routed through hoodheist feeds two ledgers all week: each coin's total (the burn
            leaderboard above) and your personal total (your reward share).
          </p>
        </div>
        <div className="fly-fact">
          <b>The burn is permissionless</b>
          <p>
            When the week closes, anyone can fire it: the pot market-buys the top 3 (50/30/20)
            and burns the coins on the spot. Our keeper triggers it automatically if nobody
            beats it to the punch.
          </p>
        </div>
        <div className="fly-fact">
          <b>No promises, just claims</b>
          <p>
            The trader pool accrues on-chain from day one. When a week closes, your pro-rata
            ETH share unlocks on your Profile. No points program, no snapshot, no waiting.
          </p>
        </div>
      </section>
    </div>
  );
}
