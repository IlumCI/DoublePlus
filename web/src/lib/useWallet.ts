import { useEffect } from "react";
import { useAccount, useConnect, useDisconnect, useWalletClient } from "wagmi";
import { getChainId, getWalletClient, switchChain } from "wagmi/actions";

import { client } from "./client";
import { chain } from "./env";
import { openWalletModal, wagmiConfig } from "./wagmi";
import { useUi } from "../store";

/**
 * Attach the connected wallet to the SDK right now. Used at transaction
 * time so a submit can never race the useWalletClient query.
 */
export async function ensureSdkWallet(): Promise<boolean> {
  try {
    // Auto-switch (and add, if missing) Robinhood Chain in the wallet, so
    // users never have to configure the network manually.
    if (getChainId(wagmiConfig) !== chain.id) {
      await switchChain(wagmiConfig, { chainId: chain.id });
    }
    const wc = await getWalletClient(wagmiConfig, { chainId: chain.id });
    if (!wc) return false;
    client.connectWallet(wc);
    return true;
  } catch {
    return false;
  }
}

/** Connection state plus automatic SDK wallet attachment. */
export function useWallet() {
  const { address, isConnected, chainId } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { data: walletClient } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);

  useEffect(() => {
    if (walletClient) client.connectWallet(walletClient);
  }, [walletClient]);

  const connectFirst = async () => {
    // Open the Reown AppKit modal, which lists every wallet (injected, mobile
    // via WalletConnect, Coinbase) and handles the connection. Its UI is loaded
    // on demand here so none of that weight sits on the first paint.
    try {
      await openWalletModal();
    } catch (err) {
      pushToast({ kind: "error", title: "Could not open wallet", body: errorText(err) });
    }
  };

  return { address, isConnected, chainId, connectors, connect, connectFirst, disconnect, isPending };
}

/** Compact error text from viem/wagmi exceptions for toasts. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const short = raw.split("\n")[0];
  if (/user rejected/i.test(raw)) return "Transaction rejected in wallet.";
  if (/No wallet connected/i.test(raw)) return "Wallet session expired. Reconnect your wallet and try again.";
  if (/MaxTransactionExceeded/.test(raw)) return "Trade exceeds the max transaction limit for this token.";
  if (/MaxWalletExceeded/.test(raw)) return "This buy would exceed the max wallet limit for this token.";
  if (/BuyCooldownActive/.test(raw)) return "Buy cooldown is active for your wallet. Wait a moment and retry.";
  return short.length > 200 ? short.slice(0, 200) + "..." : short;
}
