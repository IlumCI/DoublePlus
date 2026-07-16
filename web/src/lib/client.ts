import { createPublicClient, http, type PublicClient } from "viem";
import type { LaunchpadClient } from "@launchpad/sdk";

import { chain, env } from "./env";
import { V4Client, type V4Addresses } from "./v4/client";

/** Deployed Quiver V4 launchpad on Robinhood Chain (immutable). */
const V4: V4Addresses = {
  factory: "0x548a942b6bc50944Ca7F147eA9aAE94AFd4a4663",
  hook: "0x08A27f842C32B9246B68a76734D60eeBc4d38044",
  router: "0x379ADE181d8e1dE59e5FDAeb46B0492ce4BbaC9f",
  poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
  weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
  usdg: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
};

const V4_START_BLOCK = 11248000n;

const publicClient = createPublicClient({
  chain,
  transport: http(env.rpcUrl),
  batch: { multicall: { wait: 16 } },
}) as PublicClient;

const v4 = new V4Client(publicClient, V4, V4_START_BLOCK);

/**
 * App-wide client singleton. It is the V4 launchpad client, cast to the v3
 * SDK's client type so the existing React hooks and pages consume it unchanged.
 */
export const client = v4 as unknown as LaunchpadClient;

/** Typed access to V4-only methods (dividends, stock, mcap scale). */
export const v4Client = v4;
