import { createConfig, http, type Config } from "wagmi";
import { injected, walletConnect } from "wagmi/connectors";

import { BRAND } from "./brand";
import { chain, env } from "./env";

const projectId = env.walletConnectProjectId;

/**
 * Wallet configuration built on wagmi's native connectors instead of a
 * heavyweight modal SDK. EIP-6963 discovery (on by default) surfaces every
 * injected browser wallet, so desktop users connect instantly with zero
 * extra download. The WalletConnect and Coinbase SDKs are code-split by the
 * connectors themselves and only fetched the first time a visitor actually
 * chooses that path, keeping ~3 MB of wallet code off the first paint.
 * Coinbase and other extensions are picked up by EIP-6963 injected discovery;
 * Coinbase mobile connects over WalletConnect, so no extra SDK is bundled.
 */
const connectors = [
  injected({ shimDisconnect: true }),
  ...(projectId
    ? [
        walletConnect({
          projectId,
          showQrModal: true,
          metadata: {
            name: BRAND.name,
            description: BRAND.description,
            url: BRAND.url,
            icons: [`${BRAND.url}/icon.png`],
          },
        }),
      ]
    : []),
];

export const wagmiConfig: Config = createConfig({
  chains: [chain],
  connectors,
  transports: { [chain.id]: http(env.rpcUrl, { batch: { wait: 16 } }) },
});
