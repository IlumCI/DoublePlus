// Build step for the Worker (wrangler.toml): bundles every system deployed on
// the chain, oldest first, as deployments.gen.json.
//   node make-deployments.mjs venture-robinhood.json
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { listDeployments } from "./deployments.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const file = process.argv[2];
if (!file) throw new Error("usage: node make-deployments.mjs <deployment file name>");
const all = listDeployments(join(here, "../contracts/deployments"), file);
if (all.length === 0) throw new Error(`no ${file} in contracts/deployments`);
writeFileSync(join(here, "deployments.gen.json"), JSON.stringify(all.map((d) => d.dep), null, 2));
console.log(`deployments.gen.json: ${all.map((d) => `${d.dep.contracts.factory} (from ${d.dep.startBlock})`).join(", ")}`);
