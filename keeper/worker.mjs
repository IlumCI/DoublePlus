// Cloudflare Worker that runs the venture ops keeper every minute (cron in
// wrangler.toml). The run is venture-ops-core.mjs, the same one the Node
// entry runs. A Durable Object holds a lease so a slow run is never joined by
// the next minute's (two runs at once would race each other's nonces and send
// the same fills and payouts twice), and remembers between runs what the last
// 24h of runs spent, which actions failed and are waiting to be retried, and
// the event history indexed so far (a run reads only the blocks since).
import { DurableObject } from "cloudflare:workers";
import { checkDeployment, readConfig } from "./venture-config-core.mjs";
import { runOps } from "./venture-ops-core.mjs";
// Copied in by wrangler.toml's build command for the environment's chain.
import dep from "./deployment.gen.json";

// A run stops starting work at RUN_MS, and the lease outlasts it, so a run
// still going always holds the lease. A run killed mid-way (a redeploy does
// that) holds the next ones off until LEASE_MS at most.
const RUN_MS = 4 * 60_000;
const LEASE_MS = 5 * 60_000;
const DAY_MS = 86_400_000;

export class RunLock extends DurableObject {
  // A Durable Object handles one storage step at a time, so no other call
  // lands between the read and the write. Returns null while a run holds the
  // lease, else what the run needs to know about earlier ones.
  async acquire(now) {
    if (((await this.ctx.storage.get("until")) ?? 0) > now) return null;
    await this.ctx.storage.put("until", now + LEASE_MS);
    const spends = (await this.ctx.storage.get("spends")) ?? [];
    const spentTodayWei = spends.filter(([at]) => at > now - DAY_MS).reduce((t, [, wei]) => t + BigInt(wei), 0n);
    // The index is stored in parts (meta, one per coin, one per pool) so a run
    // rewrites only what it changed.
    const index = { meta: null, coins: {}, bands: {} };
    for (const [k, v] of await this.ctx.storage.list({ prefix: "index:" })) {
      const [, kind, id] = k.split(":");
      if (kind === "meta") index.meta = v;
      else if (kind === "coin") index.coins[id] = v;
      else if (kind === "bands") index.bands[id] = v;
    }
    return { spentTodayWei: spentTodayWei.toString(), backoff: (await this.ctx.storage.get("backoff")) ?? {}, index };
  }
  async release(now, spentWei, backoff, indexParts = {}) {
    const spends = ((await this.ctx.storage.get("spends")) ?? []).filter(([at]) => at > now - DAY_MS);
    if (BigInt(spentWei) > 0n) spends.push([now, spentWei]);
    await this.ctx.storage.put({ spends, backoff, ...indexParts });
    await this.ctx.storage.delete("until");
  }
}

export default {
  async scheduled(_event, env) {
    const lock = env.LOCK.get(env.LOCK.idFromName("venture-ops"));
    const held = await lock.acquire(Date.now());
    if (!held) {
      console.log("previous run still going; skipped");
      return;
    }
    const memory = { spentTodayWei: BigInt(held.spentTodayWei), backoff: held.backoff, index: held.index, deadlineMs: Date.now() + RUN_MS };
    try {
      const cfg = readConfig(env);
      const where = `bundled deployment (chain ${dep.chainId})`;
      checkDeployment(dep, cfg.CHAIN_ID, where);
      const s = await runOps({ cfg, dep, depPath: where, memory });
      // Thrown so the run shows as failed in the Workers dashboard.
      if (s.solvency.ok === false) throw new Error(`CRITICAL factory insolvent: ${JSON.stringify(s.solvency)}`);
    } finally {
      // Recorded even when the run threw: what it spent before failing counts.
      const parts = {};
      for (const key of memory.indexDirty ?? []) {
        const [kind, id] = key.split(":");
        parts[`index:${key}`] = kind === "meta" ? memory.index.meta : kind === "coin" ? memory.index.coins[id] : memory.index.bands[id];
      }
      await lock.release(Date.now(), String(memory.spentWei ?? 0n), memory.backoff, parts);
    }
  },
};
