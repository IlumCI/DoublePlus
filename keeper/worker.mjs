// Cloudflare Worker that runs the venture ops keeper every minute (cron in
// wrangler.toml). The run is venture-ops-core.mjs, the same one the Node
// entry runs. A Durable Object holds a lease so a slow run is never joined by
// the next minute's: two runs at once would race each other's nonces and send
// the same fills and payouts twice.
import { DurableObject } from "cloudflare:workers";
import { checkDeployment, readConfig } from "./venture-config-core.mjs";
import { runOps } from "./venture-ops-core.mjs";
// Copied in by wrangler.toml's build command for the environment's chain.
import dep from "./deployment.gen.json";

// Longer than any run can last (the cron's wall clock stops at 15 min), so a
// run that dies without releasing only holds the next ones off until then.
const LEASE_MS = 15 * 60_000;

export class RunLock extends DurableObject {
  // A Durable Object handles one storage step at a time, so no other call
  // lands between the read and the write.
  async acquire(now) {
    if (((await this.ctx.storage.get("until")) ?? 0) > now) return false;
    await this.ctx.storage.put("until", now + LEASE_MS);
    return true;
  }
  async release() {
    await this.ctx.storage.delete("until");
  }
}

export default {
  async scheduled(_event, env) {
    const lock = env.LOCK.get(env.LOCK.idFromName("venture-ops"));
    if (!(await lock.acquire(Date.now()))) {
      console.log("previous run still going; skipped");
      return;
    }
    try {
      const cfg = readConfig(env);
      const where = `bundled deployment (chain ${dep.chainId})`;
      checkDeployment(dep, cfg.CHAIN_ID, where);
      const s = await runOps({ cfg, dep, depPath: where });
      // Thrown so the run shows as failed in the Workers dashboard.
      if (!s.solvency.ok) throw new Error(`CRITICAL factory insolvent: ${JSON.stringify(s.solvency)}`);
    } finally {
      await lock.release();
    }
  },
};
