import { toFunctionSelector } from "viem";
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
/** What the contracts' custom errors mean to the person who hit them. Matched
 *  by name (when the ABI carried it) or by 4-byte selector (when it didn't). */
const CONTRACT_ERRORS: Record<string, string> = {
  SlippageExceeded: "The price moved past your slippage limit before your trade went through. Nothing was spent. Try again, or allow more slippage.",
  Slippage: "The price moved past your slippage limit before your trade went through. Nothing was spent. Try again, or allow more slippage.",
  CapExceeded: "That's over this coin's max per wallet. The buy box shows how much you can still put in.",
  CurveClosed: "This curve is closed: the coin has graduated or its raise has ended.",
  CurveLive: "The raise is still open.",
  AlreadyFinalized: "This coin has already graduated.",
  NothingToSell: "This wallet has nothing to sell back to the curve.",
  NothingToRefund: "There's nothing to refund or withdraw for this wallet.",
  NotAborted: "Refunds aren't open for this coin.",
  AlreadySwept: "The refund window for this coin has closed.",
  InvalidParams: "Those values were refused. Check the amount and settings and try again.",
  BadVanity: "The coin address didn't match. Try launching again.",
  LaunchesPaused_: "Launching is paused right now. Trading is unaffected.",
  EthTransferFailed: "Your wallet couldn't receive the ETH.",
  PriceMoving: "The price is still moving. Try again in a minute.",
  ReentrancyGuardReentrantCall: "That call was refused.",
  NoFlip: "This coin's creator turned on no same-second flips: you can't buy and sell it in the same second. Wait a second and try again.",
  NotListed: "That coin isn't listed on DoublePlus.",
  BadHours: "Boosts run from 1 to 168 hours.",
  WrongPayment: "The boost price changed. Refresh and try again.",
  PayFailed: "The payment couldn't be delivered. Nothing was spent.",
  NotOwner: "Only the wallet that placed this order can cancel it.",
  Closed: "That order is already filled, cancelled or expired.",
  BelowFloor: "The price isn't at your limit yet, so the order can't fill.",
  BadOrder: "That order was refused. Check the amount and expiry.",
  BadRoute: "That payout option isn't available. Pick another.",
  NotAgent: "Picking a payout asset needs at least the 5x holder tier.",
  NotCreator: "Only this coin's creator can do that.",
  NotDevWallet: "Only this coin's creator can do that.",
  OnlyBeneficiary: "Only the founder can claim these tokens.",
  NothingToClaim: "Nothing has unlocked yet.",
  NotStarted: "Vesting starts when the coin graduates.",
  PotNotWon: "The pot can be claimed once its timer runs out with a leader.",
  SweepTooEarly: "Unclaimed refunds can't be swept yet.",
  BadPolicy: "Those settings were refused: a referrer can't be yourself, and extras must stay within their limits.",
  FloorTooHigh: "The minimum hold for dividends can be at most 1% of supply.",
  BadDividendPolicy: "Set a share of fees for holders before setting a minimum hold.",
  WrongRewardCurrency: "This coin pays dividends in another asset.",
  FeeTooHigh: "That fee is above the platform maximum.",
  AlreadyConfigured: "Extras can only be set once, within 10 minutes of launch, before the coin graduates.",
};
const SELECTOR_TO_NAME: Record<string, string> = Object.fromEntries(
  Object.keys(CONTRACT_ERRORS).map((n) => [toFunctionSelector(`${n}()`), n]),
);

/** A wallet or contract error, in words a trader can act on. */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? `${err.message} ${(err as { details?: string }).details ?? ""}` : String(err);
  if (/user rejected|user denied|rejected the request/i.test(raw)) return "Transaction rejected in wallet.";
  if (/No wallet connected|connector not connected/i.test(raw)) return "Wallet session expired. Reconnect your wallet and try again.";
  const chainMismatch = /does not match the target chain|chain mismatch|wallet is on another chain/i.test(raw);
  if (chainMismatch) return `Your wallet is on another network. Switch it to ${chain.name} and try again.`;
  if (/insufficient funds|exceeds (the )?balance|gas required exceeds|Missing or invalid parameters/i.test(raw)) {
    return "Not enough ETH to cover this and the network fee.";
  }
  if (/unknown RPC error|Failed to fetch|NetworkError|HTTP request failed|fetch failed|network (is )?(down|error|changed)|ERR_INTERNET_DISCONNECTED|timed? ?out/i.test(raw)) {
    return "Couldn't reach the network. Check your connection; nothing was sent, so you can try again.";
  }
  const named = /Error: (\w+)\(/.exec(raw)?.[1] ?? /errorName[":\s]+(\w+)/.exec(raw)?.[1];
  if (named && CONTRACT_ERRORS[named]) return CONTRACT_ERRORS[named];
  const sel = /0x[0-9a-fA-F]{8}\b/.exec(raw.slice(raw.search(/signature|reverted|revert/i) + 1))?.[0]?.toLowerCase();
  if (sel && SELECTOR_TO_NAME[sel]) return CONTRACT_ERRORS[SELECTOR_TO_NAME[sel]];
  if (/reverted|execution reverted|would revert/i.test(raw)) return "The transaction would fail on-chain, so it wasn't sent. Nothing was spent.";
  if (/failed on-chain/i.test(raw)) return raw.split("\n")[0];
  const short = raw.split("\n")[0].trim();
  return short.length > 200 ? short.slice(0, 200) + "..." : short;
}

/** Thrown when a transaction was mined but reverted. */
export class RevertedOnChain extends Error {
  constructor() { super("It went through but failed on-chain. Nothing changed except the network fee."); }
}
