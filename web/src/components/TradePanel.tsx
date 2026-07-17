import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { launchTokenAbi, type Address, type TokenSummary } from "@launchpad/sdk";

import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { fmtWei, compact } from "../lib/format";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

type Side = "buy" | "sell";

// Quick-buy amounts in native currency, launchpad style.
const BUY_PRESETS = ["0.01", "0.05", "0.1", "0.5"];

export function TradePanel({ token }: { token: TokenSummary }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(5); // % slippage tolerance
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

  const taxBps = Number(token.feeTier) || 0;
  const feeRate = taxBps / 10000;

  const estimate = useMemo(() => {
    if (!parsedAmount || parsedAmount === 0n) return null;
    const price = Number(token.priceWei) / 1e18;
    if (price <= 0) return null;
    if (side === "buy") {
      const nativeIn = Number(parsedAmount) / 1e18;
      return `~ ${compact((nativeIn * (1 - feeRate)) / price)} ${token.symbol}`;
    }
    const tokensIn = Number(parsedAmount) / 1e18;
    return `~ ${(tokensIn * price * (1 - feeRate)).toFixed(6)} ${env.nativeSymbol}`;
  }, [parsedAmount, side, token.priceWei, token.symbol, feeRate]);

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
      // Min output from the current-price estimate, less fee and slippage.
      const price = Number(token.priceWei);
      const slipMul = Math.max(0, 1 - slip / 100) * (1 - feeRate);
      let minOut = 0n;
      if (price > 0) {
        const out =
          side === "buy"
            ? (Number(parsedAmount) * 1e18) / price // token wei
            : (Number(parsedAmount) * price) / 1e18; // weth wei
        minOut = BigInt(Math.max(0, Math.floor(out * slipMul)));
      }
      const hash =
        side === "buy"
          ? await v4Client.buyToken(token.address as Address, parsedAmount, minOut)
          : await v4Client.sellToken(token.address as Address, parsedAmount, minOut);
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

  const balance = side === "buy" ? nativeBalance : tokenBalance;

  return (
    <div className="flex h-fit flex-col gap-3 rounded-xl border border-edge bg-panel p-3">
      {/* Buy / Sell toggle */}
      <div className="grid grid-cols-2 gap-1">
        {(["buy", "sell"] as Side[]).map((s) => (
          <button
            key={s}
            onClick={() => { setSide(s); setAmount(""); }}
            className={`h-8 rounded-lg text-[13px] font-semibold capitalize transition-colors ${
              side === s
                ? s === "buy" ? "bg-up text-white" : "bg-down text-white"
                : "bg-panel-2 text-ink-2 hover:text-ink"
            }`}
          >
            {s}
          </button>
        ))}
      </div>

      {/* Amount */}
      <div className="rounded-lg border border-edge bg-panel-2/40 px-3 py-2.5">
        <div className="mb-1 flex items-baseline justify-between text-[10.5px]">
          <span className="text-ink-3">{side === "buy" ? env.nativeSymbol : token.symbol}</span>
          <button className="tnum text-ink-3 transition-colors hover:text-ink" onClick={() => setPct(100)}>
            Bal {balance != null ? fmtWei(balance) : "0"}
          </button>
        </div>
        <input
          value={amount}
          onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
          placeholder="0.0"
          inputMode="decimal"
          className="mono w-full bg-transparent text-[18px] text-ink outline-none placeholder:text-ink-3"
        />
      </div>

      {/* Presets */}
      <div className="grid grid-cols-4 gap-1">
        {(side === "buy" ? BUY_PRESETS : ["25", "50", "75", "Max"]).map((v, i) => (
          <button
            key={v}
            onClick={() => (side === "buy" ? setAmount(v) : setPct([25, 50, 75, 100][i]))}
            className="tnum h-7 rounded-md border border-edge text-[11px] font-medium text-ink-2 transition-colors hover:border-edge-2 hover:text-ink"
          >
            {v}
          </button>
        ))}
      </div>

      {/* Estimate */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-ink-3">You receive</span>
        <span className="tnum font-semibold text-ink">{estimate ?? "—"}</span>
      </div>

      {/* Slippage */}
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-ink-3">Slippage</span>
        <div className="flex items-center gap-1">
          {[1, 5, 10].map((p) => (
            <button
              key={p}
              onClick={() => setSlip(p)}
              className={`tnum rounded px-1.5 py-0.5 transition-colors ${slip === p ? "bg-accent/15 font-semibold text-accent-ink" : "text-ink-3 hover:text-ink"}`}
            >
              {p}%
            </button>
          ))}
          <span className="flex items-center rounded bg-panel-2 pr-1">
            <input
              value={String(slip)}
              onChange={(e) => {
                const v = Number(e.target.value.replace(/[^0-9.]/g, ""));
                if (!isNaN(v)) setSlip(Math.min(50, v));
              }}
              inputMode="decimal"
              className="mono w-7 bg-transparent py-0.5 text-right text-ink outline-none"
            />
            <span className="text-ink-3">%</span>
          </span>
        </div>
      </div>

      {isConnected ? (
        <button
          onClick={submit}
          disabled={busy || !parsedAmount || parsedAmount === 0n || Boolean(insufficientFunds)}
          className={`h-11 rounded-lg text-[14px] font-semibold transition-colors disabled:cursor-not-allowed disabled:bg-panel-2 disabled:text-ink-3 ${
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
          className="h-11 rounded-lg bg-accent text-[14px] font-semibold text-accent-fg transition-colors hover:bg-accent-2"
        >
          Connect Wallet
        </button>
      )}

    </div>
  );
}
