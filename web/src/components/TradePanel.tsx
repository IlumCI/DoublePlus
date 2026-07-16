import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { launchTokenAbi, type Address, type TokenSummary } from "@launchpad/sdk";

import { client } from "../lib/client";
import { env } from "../lib/env";
import { fmtWei, compact } from "../lib/format";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

type Side = "buy" | "sell";

const FEE = 0.01; // fixed 1%, paid to the creator

// Quick-buy amounts in native currency, launchpad style.
const BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"];

export function TradePanel({ token }: { token: TokenSummary }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [nativeBalance, setNativeBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);

  const refreshBalances = async () => {
    if (!address) {
      setNativeBalance(null);
      setTokenBalance(null);
      return;
    }
    const [native, tok] = await Promise.all([
      client.publicClient.getBalance({ address }),
      client.publicClient.readContract({
        address: token.address,
        abi: launchTokenAbi,
        functionName: "balanceOf",
        args: [address],
      }),
    ]);
    setNativeBalance(native);
    setTokenBalance(tok);
  };

  useEffect(() => {
    refreshBalances().catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [address, token.address]);

  const parsedAmount = useMemo(() => {
    try {
      return amount ? parseEther(amount as `${number}`) : 0n;
    } catch {
      return null;
    }
  }, [amount]);

  const estimate = useMemo(() => {
    if (!parsedAmount || parsedAmount === 0n) return null;
    const price = Number(token.priceWei) / 1e18;
    if (price <= 0) return null;
    if (side === "buy") {
      const nativeIn = Number(parsedAmount) / 1e18;
      return `~ ${compact((nativeIn * (1 - FEE)) / price)} ${token.symbol}`;
    }
    const tokensIn = Number(parsedAmount) / 1e18;
    return `~ ${(tokensIn * price * (1 - FEE)).toFixed(6)} ${env.nativeSymbol}`;
  }, [parsedAmount, side, token.priceWei, token.symbol]);

  const setPct = (pct: number) => {
    if (side === "sell" && tokenBalance != null) {
      setAmount(formatEther((tokenBalance * BigInt(pct)) / 100n));
    } else if (side === "buy" && nativeBalance != null) {
      const usable = pct === 100 ? (nativeBalance * 98n) / 100n : (nativeBalance * BigInt(pct)) / 100n;
      setAmount(formatEther(usable));
    }
  };

  const submit = async () => {
    if (!parsedAmount || parsedAmount === 0n) return;
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) {
        throw new Error("Wallet session expired. Reconnect your wallet and try again.");
      }
      const hash =
        side === "buy"
          ? await client.buyToken(token.address as Address, parsedAmount)
          : await client.sellToken(token.address as Address, parsedAmount);
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${side === "buy" ? "Buy" : "Sell"} confirmed`, txHash: hash });
      setAmount("");
      await refreshBalances();
    } catch (err) {
      pushToast({ kind: "error", title: "Transaction failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const insufficientFunds =
    parsedAmount != null &&
    ((side === "buy" && nativeBalance != null && parsedAmount > nativeBalance) ||
      (side === "sell" && tokenBalance != null && parsedAmount > tokenBalance));

  return (
    <div className="flex h-fit flex-col gap-4 rounded-xl border border-edge bg-panel p-4 shadow-[var(--shadow-card)]">
      <div className="grid grid-cols-2 rounded-full bg-panel-2 p-1">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            onClick={() => {
              setSide(s);
              setAmount("");
            }}
            className={`h-9 rounded-full text-sm font-semibold capitalize transition-colors ${
              side === s ? (s === "buy" ? "bg-up text-white" : "bg-down text-white") : "text-ink-2 hover:text-ink"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="font-medium text-ink-2">
            {side === "buy" ? `Amount (${env.nativeSymbol})` : `Amount (${token.symbol})`}
          </span>
          <button className="tnum text-ink-3 transition-colors hover:text-ink" onClick={() => setPct(100)}>
            Balance{" "}
            {side === "buy"
              ? nativeBalance != null
                ? fmtWei(nativeBalance)
                : "0"
              : tokenBalance != null
                ? fmtWei(tokenBalance)
                : "0"}
          </button>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.0"
          inputMode="decimal"
          className="mono w-full rounded-lg border border-edge bg-panel px-3.5 py-3 text-lg text-ink outline-none transition-colors placeholder:text-ink-3 focus:border-edge-2"
        />
        <div className="mt-2 grid grid-cols-4 gap-1.5">
          {side === "buy"
            ? BUY_PRESETS.map((v) => (
                <button
                  key={v}
                  onClick={() => setAmount(v)}
                  className="tnum h-8 rounded-full border border-edge text-xs font-medium text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
                >
                  {v}
                </button>
              ))
            : [25, 50, 75, 100].map((pct) => (
                <button
                  key={pct}
                  onClick={() => setPct(pct)}
                  className="h-8 rounded-full border border-edge text-xs font-medium text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
                >
                  {pct === 100 ? "Max" : `${pct}%`}
                </button>
              ))}
        </div>
      </div>

      <div className="flex items-center justify-between text-xs">
        <span className="text-ink-3">You receive</span>
        <span className="tnum font-semibold text-ink">{estimate ?? "-"}</span>
      </div>

      {isConnected ? (
        <button
          onClick={submit}
          disabled={busy || !parsedAmount || parsedAmount === 0n || Boolean(insufficientFunds)}
          className={`h-12 rounded-full text-[15px] font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-ink-3 ${
            side === "buy" ? "bg-up text-white hover:brightness-110" : "bg-down text-white hover:brightness-105"
          }`}
        >
          {busy
            ? "Confirm in wallet"
            : insufficientFunds
              ? "Insufficient balance"
              : side === "buy"
                ? `Buy ${token.symbol}`
                : `Sell ${token.symbol}`}
        </button>
      ) : (
        <button
          onClick={connectFirst}
          className="h-12 rounded-full bg-accent text-[15px] font-semibold text-white transition-colors hover:bg-accent-2"
        >
          Connect Wallet
        </button>
      )}

      <p className="text-center text-[11px] text-ink-3">1% trading fee, paid to the token creator</p>
    </div>
  );
}
