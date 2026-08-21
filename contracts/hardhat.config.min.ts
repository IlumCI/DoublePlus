import { HardhatUserConfig } from "hardhat/config";
// Minimal config: skip the full hardhat-toolbox (its ignition chain is broken
// in this environment) and load only what compile + fork-tests need.
import "@nomicfoundation/hardhat-ethers";
import "@nomicfoundation/hardhat-network-helpers";
import "@nomicfoundation/hardhat-chai-matchers";
import * as dotenv from "dotenv";

dotenv.config();
dotenv.config({ path: ".env.deployer" });

const ROBINHOOD_RPC_URL = process.env.ROBINHOOD_RPC_URL ?? "";
const ROBINHOOD_CHAIN_ID = Number(process.env.ROBINHOOD_CHAIN_ID ?? 0);
const PRIVATE_KEY = process.env.PRIVATE_KEY;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.26",
    settings: {
      optimizer: { enabled: true, runs: 400 },
      viaIR: true,
    },
  },
  networks: {
    hardhat: {
      allowUnlimitedContractSize: false,
      ...(process.env.FORK === "1" && ROBINHOOD_RPC_URL
        ? {
            hardfork: process.env.FORK_HARDFORK ?? "cancun",
            forking: {
              url: ROBINHOOD_RPC_URL,
              ...(process.env.BASE_FORK_BLOCK ? { blockNumber: Number(process.env.BASE_FORK_BLOCK) } : {}),
            },
            chainId: ROBINHOOD_CHAIN_ID || undefined,
          }
        : {}),
    },
    ...(ROBINHOOD_RPC_URL
      ? {
          robinhood: {
            url: ROBINHOOD_RPC_URL,
            chainId: ROBINHOOD_CHAIN_ID || undefined,
            accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
          },
        }
      : {}),
  },
  mocha: { timeout: 180_000 },
};

export default config;
