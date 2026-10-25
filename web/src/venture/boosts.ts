import { useEffect, useState } from "react";
import { zeroAddress, type Address } from "viem";

import { boostedEvent, boostsAbi, EVERY, venturePc } from "./client";
import { chainNowSecs } from "./clock";

export interface LiveBoost { until: number; paid: bigint }

/** Every coin with a live boost, re-read every minute. Coins come from the
 *  Boosted log; the contract says which runs are still live and what they paid. */
export function useBoosts(): Map<string, LiveBoost> {
  const [boosts, setBoosts] = useState<Map<string, LiveBoost>>(new Map());
  useEffect(() => {
    if (EVERY.boosts.length === 0) return;
    let live = true;
    const load = async () => {
      const logs = await venturePc.getLogs({ address: EVERY.boosts, event: boostedEvent, fromBlock: EVERY.startBlock, toBlock: "latest" });
      const now = chainNowSecs();
      // Only coins whose last boost could still be running need a read, on
      // the boosts contract of the coin's own system.
      const latest = new Map<string, number>();
      const via = new Map<string, Address>();
      for (const l of logs) {
        const c = l.args.coin!.toLowerCase();
        latest.set(c, Math.max(latest.get(c) ?? 0, Number(l.args.until)));
        via.set(c, l.address);
      }
      const coins = [...latest].filter(([, until]) => until > now).map(([c]) => c as Address);
      const reads = await Promise.all(coins.map((c) => venturePc.readContract({ address: via.get(c)!, abi: boostsAbi, functionName: "activeBoost", args: [c] })));
      const m = new Map<string, LiveBoost>();
      coins.forEach((c, i) => { const [until, paid] = reads[i]; if (paid > 0n) m.set(c, { until: Number(until), paid }); });
      if (live) setBoosts(m);
    };
    load().catch(() => undefined);
    const id = setInterval(() => load().catch(() => undefined), 60_000);
    return () => { live = false; clearInterval(id); };
  }, []);
  return boosts;
}
