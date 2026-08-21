import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { defineChain } from "@reown/appkit/networks";
import { http } from "viem";
import type { Config } from "wagmi";

import { BRAND } from "./brand";
import { chain, env } from "./env";

/**
 * Reown AppKit wallet integration. The WagmiAdapter owns the wagmi config so
 * AppKit's modal and our wagmi hooks share one connection state; it registers
 * the injected, WalletConnect and Coinbase connectors from a single project id.
 *
 * The AppKit modal UI (its web components) is heavy, so `createAppKit` is called
 * lazily by `openWalletModal()` the first time a visitor connects; none of that
 * UI weight touches the first paint. Account/session reads go through the normal
 * wagmi hooks, which work off `wagmiConfig` whether or not the modal is open yet.
 */
// Wallets accept a single RPC endpoint; the app's own reads use the full
// comma-separated fallback list (see lib/client.ts).
const primaryRpc = env.rpcUrl.split(",")[0].trim();

const appKitNetwork = defineChain({
  id: chain.id,
  caipNetworkId: `eip155:${chain.id}`,
  chainNamespace: "eip155",
  name: chain.name,
  nativeCurrency: chain.nativeCurrency,
  rpcUrls: { default: { http: [primaryRpc] } },
  ...(env.explorerUrl
    ? { blockExplorers: { default: { name: "Explorer", url: env.explorerUrl } } }
    : {}),
});

// Base mainnet, for the Circle Gateway bridge (deposit side). Registered with
// the wallet stack so the bridge page can switch networks and transact there.
const baseNetwork = defineChain({
  id: 8453,
  caipNetworkId: "eip155:8453",
  chainNamespace: "eip155",
  name: "Base",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://mainnet.base.org"] } },
  blockExplorers: { default: { name: "BaseScan", url: "https://basescan.org" } },
});

const wagmiAdapter = new WagmiAdapter({
  networks: [appKitNetwork, baseNetwork],
  projectId: env.walletConnectProjectId,
  transports: {
    [chain.id]: http(primaryRpc, { batch: { wait: 16 } }),
    8453: http("https://mainnet.base.org", { batch: { wait: 16 } }),
  },
});

export const wagmiConfig = wagmiAdapter.wagmiConfig as Config;

let modalPromise: Promise<{ open: () => void }> | null = null;

/**
 * Open the Reown AppKit wallet modal, lazily creating it (and loading its SDK)
 * on first use. Subsequent calls reuse the same modal instance.
 */
export function openWalletModal(): Promise<void> {
  if (!env.walletConnectProjectId) {
    return Promise.reject(new Error("Wallet is not configured (missing project id)."));
  }
  if (!modalPromise) {
    modalPromise = import("@reown/appkit/react").then(({ createAppKit }) =>
      createAppKit({
        adapters: [wagmiAdapter],
        networks: [appKitNetwork, baseNetwork],
        defaultNetwork: appKitNetwork,
        projectId: env.walletConnectProjectId,
        metadata: {
          name: BRAND.name,
          description: BRAND.description,
          url: BRAND.url,
          icons: [`${BRAND.url}/icon.png`],
        },
        themeMode: "dark",
        themeVariables: {
          "--w3m-accent": "#a3e635",
          "--w3m-border-radius-master": "2px",
        },
        features: { analytics: false, email: false, socials: [] },
      }),
    );
  }
  return modalPromise.then((modal) => modal.open());
}
