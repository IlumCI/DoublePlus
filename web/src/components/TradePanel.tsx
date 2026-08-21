import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther } from "viem";
import { launchTokenAbi, type Address, type TokenSummary } from "@launchpad/sdk";

import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { fmtWei, fmtUsd, compact } from "../lib/format";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";
import { TokenLogo } from "./TokenLogo";

type Side = "buy" | "sell";

// Quick-buy amounts in native currency, launchpad style. On Stable the
// native currency is a dollar, so the presets read as dollar amounts.
const BUY_PRESETS =
  String(import.meta.env.VITE_PROTOCOL ?? "") === "stable-v3"
    ? ["1", "5", "10", "25"]
    : ["0.01", "0.05", "0.1", "0.5"];

/** The official Ethereum diamond mark, in a white coin badge. */
function EthBadge({ size = 22 }: { size?: number }) {
  return (
    <span
      className="grid shrink-0 place-items-center overflow-hidden rounded-full bg-white ring-1 ring-edge"
      style={{ width: size, height: size }}
      aria-label="Ethereum"
    >
      <svg width={size * 0.56} height={size * 0.56} viewBox="0 0 256 417" xmlns="http://www.w3.org/2000/svg" aria-hidden>
        <path fill="#343434" d="M127.961 0l-2.795 9.5v275.668l2.795 2.79 127.962-75.638z" />
        <path fill="#8C8C8C" d="M127.962 0L0 212.32l127.962 75.639V154.158z" />
        <path fill="#3C3C3B" d="M127.961 312.187l-1.575 1.92v98.199l1.575 4.601L256 236.587z" />
        <path fill="#8C8C8C" d="M127.962 416.905v-104.72L0 236.585z" />
        <path fill="#141414" d="M127.961 287.958l127.96-75.637-127.96-58.162z" />
        <path fill="#393939" d="M0 212.32l127.96 75.638v-133.8z" />
      </svg>
    </span>
  );
}

/** Token chip shown inside the pay/receive fields: logo + ticker. */
function AssetChip({ token, native }: { token: TokenSummary; native?: boolean }) {
  return (
    <span className="tp-chip">
      {native ? <EthBadge size={20} /> : <TokenLogo token={token} size={20} />}
      <span className="text-[13px] font-bold text-ink">{native ? env.nativeSymbol : token.symbol}</span>
    </span>
  );
}

export function TradePanel({ token }: { token: TokenSummary }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);

  const [side, setSide] = useState<Side>("buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(5); // % slippage tolerance
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [nativeBalance, setNativeBalance] = useState<bigint | null>(null);
  const [tokenBalance, setTokenBalance] = useState<bigint | null>(null);
  // Diamond curve: the connected wallet's current extra sell tax, in bps.
  const [jeetBps, setJeetBps] = useState(0);

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

  useEffect(() => {
    if (!address) {
      setJeetBps(0);
      return;
    }
    let live = true;
    const load = () =>
      client.publicClient
        .readContract({
          address: token.address,
          abi: [{ type: "function", name: "sellTaxBpsOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint16" }] }] as const,
          functionName: "sellTaxBpsOf",
          args: [address],
        })
        .then((v) => live && setJeetBps(Number(v)))
        .catch(() => live && setJeetBps(0)); // pre-diamond coins have no clock
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 30_000);
    return () => {
      live = false;
      clearInterval(id);
    };
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
  const priceUsd = Number(token.priceUsd) || 0;
  // Native (ETH) per whole coin. On the pair=reward fork priceWei is
  // pair-token units, so the client ships priceEthWei alongside; older
  // protocols quote priceWei in native already.
  const priceNativeWei = Number((token as { priceEthWei?: string }).priceEthWei ?? token.priceWei);

  // Estimated output amount (in the receive token's units) and its USD value.
  const est = useMemo(() => {
    if (!parsedAmount || parsedAmount === 0n) return null;
    const price = priceNativeWei / 1e18;
    if (price <= 0) return null;
    if (side === "buy") {
      const nativeIn = Number(parsedAmount) / 1e18;
      const out = (nativeIn * (1 - feeRate)) / price; // coins out
      return { amount: out, symbol: token.symbol, usd: out * priceUsd };
    }
    const tokensIn = Number(parsedAmount) / 1e18;
    const out = tokensIn * price * (1 - feeRate); // native out
    return { amount: out, symbol: env.nativeSymbol, usd: tokensIn * priceUsd };
  }, [parsedAmount, side, priceNativeWei, token.symbol, feeRate, priceUsd]);

  // USD value of the amount being paid (best-effort; only the coin side is exact).
  const payUsd = useMemo(() => {
    if (!parsedAmount || parsedAmount === 0n) return null;
    if (side === "sell") return (Number(parsedAmount) / 1e18) * priceUsd;
    return est ? est.usd / (1 - feeRate) : null; // buy: mirror the receive USD
  }, [parsedAmount, side, priceUsd, est, feeRate]);

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
      const price = priceNativeWei;
      const slipMul = Math.max(0, 1 - slip / 100) * (1 - feeRate);
      let minOut = 0n;
      if (price > 0) {
        const out =
          side === "buy"
            ? (Number(parsedAmount) * 1e18) / price
            : (Number(parsedAmount) * price) / 1e18;
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
  const minReceived = est ? est.amount * Math.max(0, 1 - slip / 100) : 0;

  return (
    <div className="tp">
      <div className="term-head">
        Trade desk
        <span className="term-head-sub">{taxBps > 0 ? `${(feeRate * 100).toFixed(taxBps % 100 ? 1 : 0)}% flat fee` : "flat fee"}</span>
      </div>
      <div className="tp-body">
      {/* Buy / Sell segmented control */}
      <div className="tp-seg">
        <button onClick={() => { setSide("buy"); setAmount(""); }} className={`buy ${side === "buy" ? "on" : ""}`}>
          Buy
        </button>
        <button onClick={() => { setSide("sell"); setAmount(""); }} className={`sell ${side === "sell" ? "on" : ""}`}>
          Sell
        </button>
      </div>

      {/* Pay field */}
      <div className="tp-field">
        <div className="mb-1.5 flex items-baseline justify-between text-[10.5px]">
          <span className="uppercase tracking-wide text-ink-3">You pay</span>
          <button className="tnum text-ink-3 transition-colors hover:text-ink" onClick={() => setPct(100)}>
            Balance {balance != null ? fmtWei(balance) : "0"}
          </button>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
            placeholder="0.0"
            inputMode="decimal"
            className="mono min-w-0 flex-1 bg-transparent text-[22px] font-semibold text-ink outline-none placeholder:text-ink-3/60"
          />
          <AssetChip token={token} native={side === "buy"} />
        </div>
        <div className="mono mt-1 h-3.5 text-[11px] text-ink-3">{payUsd ? `≈ ${fmtUsd(payUsd)}` : ""}</div>
      </div>

      {/* Presets */}
      <div className="grid grid-cols-4 gap-1.5">
        {(side === "buy" ? BUY_PRESETS : ["25%", "50%", "75%", "Max"]).map((v, i) => (
          <button
            key={v}
            onClick={() => (side === "buy" ? setAmount(BUY_PRESETS[i]) : setPct([25, 50, 75, 100][i]))}
            className="tp-preset tnum"
          >
            {side === "buy" ? `${v} ${env.nativeSymbol}` : v}
          </button>
        ))}
      </div>

      {/* Receive field */}
      <div className="tp-field">
        <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-ink-3">You receive (est.)</div>
        <div className="flex items-center gap-2">
          <span className="mono min-w-0 flex-1 truncate text-[22px] font-semibold text-ink">
            {est ? compact(est.amount) : "0.0"}
          </span>
          <AssetChip token={token} native={side === "sell"} />
        </div>
        <div className="mono mt-1 h-3.5 text-[11px] text-ink-3">{est && est.usd > 0 ? `≈ ${fmtUsd(est.usd)}` : ""}</div>
      </div>

      {/* Diamond curve: what selling right now would cost this wallet extra */}
      {side === "sell" && jeetBps > 0 ? (
        <div className="rounded-xl border border-accent/25 bg-accent/[0.05] px-3 py-2 text-[11px] leading-relaxed text-ink-2">
          <span className="font-semibold text-accent-ink">Diamond curve:</span> selling now costs
          you an extra <span className="tnum font-semibold text-ink">{(jeetBps / 100).toFixed(jeetBps % 100 ? 1 : 0)}%</span>,
          paid to the holders who stay. It drops to 4% after 1h, 1.5% after 6h, and 0% after 24h.
        </div>
      ) : null}

      {/* Details: price, min received, fee, slippage */}
      <div className="tp-rows">
        <Row label="Price" value={priceUsd > 0 ? `${fmtUsd(priceUsd)} / ${token.symbol}` : "–"} />
        <Row label="Min. received" value={est ? `${compact(minReceived)} ${est.symbol}` : "–"} />
        <Row label="Trade fee" value={`${(feeRate * 100).toFixed(taxBps % 100 ? 1 : 0)}%`} />
        {side === "sell" && jeetBps > 0 ? (
          <Row label="Early-sell tax" value={`+${(jeetBps / 100).toFixed(jeetBps % 100 ? 1 : 0)}% to holders`} />
        ) : null}
        <div className="flex items-center justify-between pt-0.5">
          <button
            onClick={() => setShowSettings((s) => !s)}
            className="flex items-center gap-1 text-ink-3 transition-colors hover:text-ink"
          >
            Slippage <span className="tnum font-semibold text-ink-2">{slip}%</span>
            <span className={`transition-transform ${showSettings ? "rotate-180" : ""}`}>▾</span>
          </button>
          <div className={showSettings ? "flex items-center gap-1" : "hidden"}>
            {[1, 5, 10].map((p) => (
              <button
                key={p}
                onClick={() => setSlip(p)}
                className={`tnum rounded px-1.5 py-0.5 transition-colors ${
                  slip === p ? "bg-accent/15 font-semibold text-accent-ink" : "text-ink-3 hover:text-ink"
                }`}
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
      </div>

      {isConnected ? (
        <button
          onClick={submit}
          disabled={busy || !parsedAmount || parsedAmount === 0n || Boolean(insufficientFunds)}
          className={`tp-cta ${side}`}
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
        <button onClick={connectFirst} className="tp-cta buy">
          Connect wallet
        </button>
      )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-0.5">
      <span className="text-ink-3">{label}</span>
      <span className="mono font-medium text-ink-2">{value}</span>
    </div>
  );
}
