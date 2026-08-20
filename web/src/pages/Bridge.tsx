import { useCallback, useEffect, useState } from "react";
import { createPublicClient, formatUnits, http, parseUnits, type Address } from "viem";
import { useSwitchChain, useWalletClient } from "wagmi";

import { Button } from "../components/ui";
import { v4Client } from "../lib/client";
import { env } from "../lib/env";
import { errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";
import { BASE_SOURCE, USDC_DECIMALS, erc20Abi } from "../lib/bridge/gateway";

/**
 * Two-way USDC bridge between Base and Arc, run by the arcx relayer. Bridge in:
 * the wallet sends USDC on Base to the relayer, which pays native USDC on Arc
 * to the same address. Bridge out: the reverse. Each direction is one tap plus
 * an auto-claim; payouts always return to the sending address, minus a 1% fee,
 * and each deposit pays out exactly once (enforced on-chain).
 */

const RELAYER: Address = "0xe5b498a00596ab2fa0e8a86cdde15502b2552208";

const basePublic = createPublicClient({
  transport: http("https://mainnet.base.org", { batch: { wait: 16 } }),
});

const fmt = (v: bigint, dec = USDC_DECIMALS) =>
  Number(formatUnits(v, dec)).toLocaleString("en-US", { maximumFractionDigits: 2 });

export function BridgePage() {
  const { isConnected, connectFirst, address } = useWallet();
  const { data: walletClient } = useWalletClient();
  const { switchChainAsync } = useSwitchChain();
  const pushToast = useUi((s) => s.pushToast);

  const [busy, setBusy] = useState<string | null>(null);
  const [baseUsdc, setBaseUsdc] = useState<bigint | null>(null);
  const [arcUsdc, setArcUsdc] = useState<bigint | null>(null);

  const [inAmount, setInAmount] = useState("");
  const [inStage, setInStage] = useState<string | null>(null);
  const [inResult, setInResult] = useState<string | null>(null);
  const [outAmount, setOutAmount] = useState("");
  const [outStage, setOutStage] = useState<string | null>(null);
  const [outResult, setOutResult] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!address) return;
    const a = address as Address;
    void basePublic
      .readContract({ address: BASE_SOURCE.usdc, abi: erc20Abi, functionName: "balanceOf", args: [a] })
      .then((v) => setBaseUsdc(v as bigint))
      .catch(() => {});
    void v4Client.publicClient
      .getBalance({ address: a })
      .then((wei) => setArcUsdc(wei))
      .catch(() => {});
  }, [address]);

  useEffect(() => {
    refresh();
    const id = setInterval(() => {
      if (!document.hidden) refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [refresh]);

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label);
    try {
      await fn();
    } catch (err) {
      pushToast({ kind: "error", title: `${label} failed`, body: errorText(err) });
    } finally {
      setBusy(null);
    }
  };

  const ensureChain = async (chainId: number) => {
    const cur = walletClient?.chain?.id;
    if (cur !== chainId) await switchChainAsync({ chainId });
  };

  const pollClaim = async (path: string, txHash: string, setStage: (s: string) => void) => {
    for (let i = 0; i < 24; i++) {
      const r = await fetch(path, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ txHash }),
      });
      const j = await r.json().catch(() => ({}));
      if (r.ok && j.hash) return `Received ${j.amountUsdc} USDC. Tx: ${j.hash}`;
      if (r.status !== 425) throw new Error(j.error || `HTTP ${r.status}`);
      setStage("Waiting for confirmations...");
      await new Promise((res) => setTimeout(res, 6_000));
    }
    return "Deposit sent; payout is processing and will complete shortly.";
  };

  // Bridge in: Base -> Arc.
  const bridgeIn = () =>
    run("BridgeIn", async () => {
      if (!walletClient?.account) throw new Error("Connect a wallet first.");
      setInResult(null);
      const value = parseUnits(inAmount || "0", USDC_DECIMALS);
      if (value <= 0n) throw new Error("Enter an amount.");
      if (baseUsdc !== null && value > baseUsdc) throw new Error("Amount exceeds your Base USDC balance.");
      setInStage("Sending USDC on Base...");
      await ensureChain(BASE_SOURCE.chainId);
      const hash = await walletClient.writeContract({
        address: BASE_SOURCE.usdc,
        abi: erc20Abi,
        functionName: "transfer",
        args: [RELAYER, value],
        chain: walletClient.chain,
        account: walletClient.account,
      });
      await basePublic.waitForTransactionReceipt({ hash });
      setInStage("Paying out on Arc...");
      const msg = await pollClaim("/api/bridge-in", hash, setInStage);
      setInResult(msg);
      pushToast({ kind: "success", title: "Bridged to Arc", body: msg });
      setInAmount("");
      setInStage(null);
      refresh();
    });

  // Bridge out: Arc -> Base.
  const bridgeOut = () =>
    run("BridgeOut", async () => {
      if (!walletClient?.account) throw new Error("Connect a wallet first.");
      setOutResult(null);
      const value = parseUnits(outAmount || "0", 18); // native USDC is 18d on Arc
      if (value <= 0n) throw new Error("Enter an amount.");
      if (arcUsdc !== null && value > arcUsdc) throw new Error("Amount exceeds your Arc USDC balance.");
      setOutStage("Sending USDC on Arc...");
      await ensureChain(env.chainId);
      const hash = await walletClient.sendTransaction({
        account: walletClient.account,
        chain: walletClient.chain,
        to: RELAYER,
        value,
      });
      await v4Client.publicClient.waitForTransactionReceipt({ hash });
      setOutStage("Paying out on Base...");
      const msg = await pollClaim("/api/bridge-out", hash, setOutStage);
      setOutResult(msg);
      pushToast({ kind: "success", title: "Bridged to Base", body: msg });
      setOutAmount("");
      setOutStage(null);
      refresh();
    });

  const stat = (label: string, value: string) => (
    <div className="rounded-xl border border-edge bg-panel px-4 py-3">
      <p className="text-[11px] uppercase tracking-wide text-ink-3">{label}</p>
      <p className="tnum mt-0.5 text-[15px] font-semibold text-ink">{value}</p>
    </div>
  );

  const card = (opts: {
    title: string;
    subtitle: string;
    amount: string;
    setAmount: (s: string) => void;
    max: bigint | null;
    maxDec: number;
    action: () => void;
    busyLabel: string;
    cta: string;
    stage: string | null;
    result: string | null;
  }) => (
    <div className="rounded-xl border border-accent/30 bg-panel px-4 py-4">
      <p className="text-[13px] font-semibold text-ink">{opts.title}</p>
      <p className="mt-0.5 text-[12px] text-ink-3">{opts.subtitle}</p>
      <div className="mt-3 flex gap-2">
        <input
          value={opts.amount}
          onChange={(e) => opts.setAmount(e.target.value)}
          inputMode="decimal"
          placeholder="0.00"
          className="w-full rounded-lg border border-edge bg-bg px-3 py-2 text-sm text-ink outline-none focus:border-accent"
        />
        <Button variant="ghost" onClick={() => opts.max !== null && opts.setAmount(formatUnits(opts.max, opts.maxDec))}>
          Max
        </Button>
        <Button variant="primary" disabled={busy !== null} onClick={opts.action}>
          {busy === opts.busyLabel ? "Bridging" : opts.cta}
        </Button>
      </div>
      {opts.stage && <p className="mt-2 text-[12px] text-ink-2">{opts.stage}</p>}
      {opts.result && <p className="mt-2 break-all text-[12px] text-up">{opts.result}</p>}
    </div>
  );

  return (
    <div className="mx-auto max-w-2xl space-y-4 px-4 py-6">
      <div>
        <h1 className="text-lg font-bold text-ink">Bridge USDC</h1>
        <p className="mt-1 text-[13px] text-ink-2">
          Move USDC between Base and Arc in one tap. Payout lands at the same address in about a minute,
          minus a 1% fee. Per-transaction cap applies.
        </p>
      </div>

      {!isConnected ? (
        <div className="rounded-xl border border-edge bg-panel px-4 py-8 text-center">
          <p className="text-sm text-ink-2">Connect your wallet to bridge.</p>
          <div className="mt-3">
            <Button variant="primary" onClick={() => connectFirst()}>
              Connect Wallet
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-2">
            {stat("USDC on Base", baseUsdc === null ? "-" : fmt(baseUsdc))}
            {stat("USDC on Arc", arcUsdc === null ? "-" : fmt(arcUsdc, 18))}
          </div>

          {card({
            title: "Bridge in: Base to Arc",
            subtitle: "Send USDC on Base, receive native USDC on Arc at the same address.",
            amount: inAmount,
            setAmount: setInAmount,
            max: baseUsdc,
            maxDec: USDC_DECIMALS,
            action: bridgeIn,
            busyLabel: "BridgeIn",
            cta: "Bridge to Arc",
            stage: inStage,
            result: inResult,
          })}

          {card({
            title: "Bridge out: Arc to Base",
            subtitle: "Send native USDC on Arc, receive USDC on Base at the same address.",
            amount: outAmount,
            setAmount: setOutAmount,
            max: arcUsdc,
            maxDec: 18,
            action: bridgeOut,
            busyLabel: "BridgeOut",
            cta: "Bridge to Base",
            stage: outStage,
            result: outResult,
          })}

          <p className="text-[11px] text-ink-3">
            Bridge is a relay run by arcx. Deposits go to {RELAYER.slice(0, 10)}... and the payout returns
            to your sending address, minus 1%. Each deposit pays out once, enforced on-chain.
          </p>
        </>
      )}
    </div>
  );
}
