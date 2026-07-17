import { createConfig, http, type Config, type CreateConnectorFn } from "wagmi";
import { injected } from "wagmi/connectors";

import { chain, env } from "./env";

/**
 * The eager wallet config ships ONLY the injected connector (EIP-6963). It is a
 * few KB and connects every browser-extension / in-app wallet instantly with no
 * extra download. WalletConnect — ~1.3 MB of SDK — is deliberately NOT imported
 * here; it is built on demand by `loadWalletConnect()` the first time a visitor
 * needs a mobile / QR connection, so none of it touches the first paint. We use
 * wagmi's own connectors rather than Reown/AppKit precisely to keep this weight
 * off production load.
 */
export const wagmiConfig: Config = createConfig({
  chains: [chain],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [chain.id]: http(env.rpcUrl, { batch: { wait: 16 } }) },
});

let wcPromise: Promise<CreateConnectorFn | null> | null = null;

/**
 * Lazily build the WalletConnect connector, dynamically importing its SDK so it
 * is fetched only when actually used. Returns a `CreateConnectorFn` that wagmi's
 * `connect({ connector })` sets up automatically, or null when no project id is
 * configured. Memoized so repeated calls reuse the same connector.
 */
export function loadWalletConnect(): Promise<CreateConnectorFn | null> {
  if (!env.walletConnectProjectId) return Promise.resolve(null);
  if (wcPromise) return wcPromise;
  wcPromise = (async () => {
    const [{ walletConnect }, { BRAND }] = await Promise.all([
      import("wagmi/connectors"),
      import("./brand"),
    ]);
    return walletConnect({
      projectId: env.walletConnectProjectId,
      showQrModal: true,
      metadata: {
        name: BRAND.name,
        description: BRAND.description,
        url: BRAND.url,
        icons: [`${BRAND.url}/icon.png`],
      },
    });
  })();
  return wcPromise;
}
