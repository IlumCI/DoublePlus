// Node side of the venture keepers' configuration: process.env, the
// deployment file on disk, and a bad setting exits the process. The readers
// themselves live in venture-config-core.mjs, shared with the Worker.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { checkDeployment, ConfigError, DEPLOYMENTS, readConfig } from "./venture-config-core.mjs";
import { listDeployments } from "./deployments.mjs";

const here = dirname(fileURLToPath(import.meta.url));

function guard(fn) {
  try { return fn(); } catch (e) {
    if (!(e instanceof ConfigError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}

export const cfg = guard(() => readConfig(process.env));
export const { DRY_RUN, RPC, KEY, LOG_CHUNK } = cfg;
export const envInt = (...a) => guard(() => cfg.envInt(...a));
export const envWei = (...a) => guard(() => cfg.envWei(...a));
export const envEth = (...a) => guard(() => cfg.envEth(...a));

/** The deployment for CHAIN_ID (or DEPLOYMENT_FILE). */
export function loadDeployment() {
  const explicit = cfg.raw("DEPLOYMENT_FILE");
  if (!explicit && !DEPLOYMENTS[cfg.CHAIN_ID]) guard(() => { throw new ConfigError(`CHAIN_ID=${cfg.CHAIN_ID} has no deployment; set DEPLOYMENT_FILE`); });
  const path = explicit ?? join(here, "../contracts/deployments", DEPLOYMENTS[cfg.CHAIN_ID]);
  let dep;
  try { dep = JSON.parse(readFileSync(path, "utf8")); } catch (e) { console.error(`can't read ${path}: ${e.message}`); process.exit(1); }
  return { dep: guard(() => checkDeployment(dep, cfg.CHAIN_ID, path, !!explicit)), depPath: path };
}

/** Every system on CHAIN_ID, oldest first: the deployment file and the
 *  predecessors kept beside it (see deployments.mjs). DEPLOYMENT_FILE may
 *  name one file or a comma-separated list instead. */
export function loadDeployments() {
  const explicit = cfg.raw("DEPLOYMENT_FILE");
  if (!explicit && !DEPLOYMENTS[cfg.CHAIN_ID]) guard(() => { throw new ConfigError(`CHAIN_ID=${cfg.CHAIN_ID} has no deployment; set DEPLOYMENT_FILE`); });
  let all;
  try {
    all = explicit
      ? explicit.split(",").map((p) => p.trim()).filter(Boolean).map((path) => ({ path, dep: JSON.parse(readFileSync(path, "utf8")) }))
      : listDeployments(join(here, "../contracts/deployments"), DEPLOYMENTS[cfg.CHAIN_ID]);
  } catch (e) { console.error(`can't read deployments: ${e.message}`); process.exit(1); }
  return all.map(({ dep, path }) => ({ dep: guard(() => checkDeployment(dep, cfg.CHAIN_ID, path, !!explicit)), depPath: path }));
}
