// Config readers shared by the Node keepers and the Cloudflare Worker: they
// read from whatever env object they're given and throw on a bad value, so
// each runtime decides how to stop. Both keepers move treasury ETH, so a
// malformed setting stops the run before anything is sent instead of being
// read as zero. An empty variable counts as unset: GitHub Actions passes unset
// vars and secrets as "".
import { ethers } from "ethers";

export const DEPLOYMENTS = {
  4663: "venture-robinhood.json",
  46630: "venture-testnet.json",
};

export class ConfigError extends Error {}
const fail = (msg) => { throw new ConfigError(msg); };

export function readConfig(env) {
  const raw = (name) => {
    const v = typeof env[name] === "string" ? env[name].trim() : undefined;
    return v === "" ? undefined : v;
  };
  /** An integer in [min, max], or the default when unset. */
  const envInt = (name, fallback, min, max) => {
    const v = raw(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v) || Number(v) < min || Number(v) > max) fail(`${name}=${v}: expected an integer from ${min} to ${max}`);
    return Number(v);
  };
  /** A non-negative integer amount (wei or token units), or the default. */
  const envWei = (name, fallback) => {
    const v = raw(name);
    if (v === undefined) return fallback;
    if (!/^\d+$/.test(v)) fail(`${name}=${v}: expected a whole number`);
    return BigInt(v);
  };
  /** An ETH amount like "0.5", in wei, or the default. */
  const envEth = (name, fallback) => {
    const v = raw(name) ?? fallback;
    if (!/^\d+(\.\d{1,18})?$/.test(v)) fail(`${name}=${v}: expected an ETH amount like 0.5`);
    return ethers.parseEther(v);
  };
  return {
    raw, envInt, envWei, envEth,
    DRY_RUN: raw("DRY_RUN") !== undefined,
    RPC: raw("RPC_URL") ?? "https://rpc.testnet.chain.robinhood.com",
    KEY: raw("KEEPER_PRIVATE_KEY") ?? fail("Set KEEPER_PRIVATE_KEY."),
    // Robinhood's RPC allows 500k blocks for one address but 100k for several
    // (the keeper's index reads every coin's transfers in one query).
    LOG_CHUNK: envInt("LOG_CHUNK", 100_000, 1, 10_000_000),
    CHAIN_ID: envInt("CHAIN_ID", 46630, 1, Number.MAX_SAFE_INTEGER),
  };
}

/** Throws unless dep is a deployment for chainId. The caller still checks it
 *  against the chain RPC_URL actually serves. */
export function checkDeployment(dep, chainId, where, explicit = false) {
  if (!dep?.contracts || (!explicit && Number(dep.chainId) !== chainId)) fail(`${where} is not a deployment for chain ${chainId}`);
  return dep;
}
