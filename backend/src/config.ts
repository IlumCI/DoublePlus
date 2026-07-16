import * as dotenv from "dotenv";
dotenv.config();

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var ${name}`);
  return v;
}

export const config = {
  rpcUrl: required("RPC_URL"),
  chainId: Number(process.env.CHAIN_ID ?? 0),
  launchpad: required("LAUNCHPAD_ADDRESS") as `0x${string}`,
  feeDistributor: required("FEE_DISTRIBUTOR_ADDRESS") as `0x${string}`,
  weth: required("WETH_ADDRESS") as `0x${string}`,
  startBlock: BigInt(process.env.START_BLOCK ?? "0"),
  port: Number(process.env.PORT ?? 8080),
  dbPath: process.env.DB_PATH ?? "./data/launchpad.db",
  pollIntervalMs: Number(process.env.POLL_INTERVAL_MS ?? 1500),
  maxBlockRange: Number(process.env.MAX_BLOCK_RANGE ?? 2000),
  refreshIntervalMs: Number(process.env.REFRESH_INTERVAL_MS ?? 30000),
};
