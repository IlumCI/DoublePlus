// Every DoublePlus system deployed on one chain, oldest first. A redeploy is a
// whole new system and the old coins stay on the old one, so the keeper runs
// all of them. deploy-venture.ts keeps the newest as <name>.json and renames
// the one it replaces to <name>.<factory prefix>.json; this reads both forms.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** [{ dep, path }] for `file` (e.g. venture-robinhood.json) and every kept
 *  predecessor beside it in `dir`, sorted by start block. */
export function listDeployments(dir, file) {
  const base = file.replace(/\.json$/, "");
  const re = new RegExp(`^${base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\.[^.]+)?\\.json$`);
  return readdirSync(dir)
    .filter((f) => re.test(f))
    .map((f) => ({ path: join(dir, f), dep: JSON.parse(readFileSync(join(dir, f), "utf8")) }))
    .sort((a, b) => Number(a.dep.startBlock ?? 0) - Number(b.dep.startBlock ?? 0));
}
