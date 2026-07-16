import { defineChain, type Chain } from "viem";
import type { LaunchpadAddresses } from "@launchpad/sdk";

function req(name: string): string {
  const v = import.meta.env[name];
  if (!v) throw new Error(`Missing ${name}; copy .env.example to .env.local and fill it in`);
  return String(v);
}

export const env = {
  chainId: Number(req("VITE_CHAIN_ID")),
  chainName: String(import.meta.env.VITE_CHAIN_NAME ?? "Robinhood Chain"),
  rpcUrl: req("VITE_RPC_URL"),
  explorerUrl: String(import.meta.env.VITE_EXPLORER_URL ?? ""),
  nativeSymbol: String(import.meta.env.VITE_NATIVE_SYMBOL ?? "ETH"),
  // Empty API URL enables backend-free mode: all data comes straight from
  // the chain over RPC with live event watching.
  apiUrl: String(import.meta.env.VITE_API_URL ?? ""),
  wsUrl: String(import.meta.env.VITE_WS_URL ?? ""),
  startBlock: String(import.meta.env.VITE_START_BLOCK ?? "0"),
  walletConnectProjectId: String(import.meta.env.VITE_WALLETCONNECT_PROJECT_ID ?? ""),
  // When true, the public Explore feed shows nothing (pre-launch / private
  // mode). Token pages by direct address and the admin console still work.
  hideTokens: String(import.meta.env.VITE_HIDE_TOKENS ?? "") === "true",
};

export const addresses: LaunchpadAddresses = {
  factory: req("VITE_FACTORY_ADDRESS") as `0x${string}`,
  tokenDeployer: req("VITE_TOKEN_DEPLOYER_ADDRESS") as `0x${string}`,
  weth: req("VITE_WETH_ADDRESS") as `0x${string}`,
};

export const chain: Chain = defineChain({
  id: env.chainId,
  name: env.chainName,
  nativeCurrency: { name: env.nativeSymbol, symbol: env.nativeSymbol, decimals: 18 },
  rpcUrls: { default: { http: [env.rpcUrl] } },
  blockExplorers: env.explorerUrl
    ? { default: { name: "Explorer", url: env.explorerUrl } }
    : undefined,
  // Canonical Multicall3 (verified deployed) so viem folds concurrent reads
  // into a single request.
  contracts: {
    multicall3: { address: "0xcA11bde05977b3631167028862bE2a173976CA11" },
  },
});
