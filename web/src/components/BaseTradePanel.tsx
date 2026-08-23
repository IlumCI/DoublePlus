import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { launchTokenAbi, type Address, type TokenSummary } from "@launchpad/sdk";

import { client, v4Client } from "../lib/client";
import { fmtUsd, compact } from "../lib/format";
import { BASE_USDC, BASE_WETH, baseStockUsd } from "../lib/base/routes";
import { baseStockOf } from "../lib/base/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";

type Side = "buy" | "sell";
type Pair = { address: Address; symbol: string; decimals: number };

const isWeth = (addr: string) => addr.toLowerCase() === BASE_WETH.toLowerCase();
/** Display label for a pair token: WETH shows as ETH, the "c"/"wt" suffixes drop. */
const disp = (addr: string, sym: string) => (isWeth(addr) ? "ETH" : sym.replace(/^wt/, "").replace(/c$/, ""));

/** USD price of a coin's pair token: $1 for USDC, ETH snapshot for WETH, else
 *  the curated stock price. */
function pairUsdOf(pair: Pair): number {
  if (pair.address.toLowerCase() === BASE_USDC.toLowerCase()) return 1;
  if (isWeth(pair.address)) return baseStockUsd(BASE_WETH);
  return baseStockOf(pair.address)?.usd ?? 0;
}

/**
 * Pair-denominated trade desk for the Base stock launchpad, laid out like the
 * pools.fun Swap card: a Pro/Instant mode toggle, Buy/Sell tabs, a Balance /
 * Value / PnL readout, an Amount field with a stepper and the pay-token unit,
 * dollar quick-buys, a "Pay with" selector and a "You receive" estimate. The
 * coin trades against its own pair token (ETH or a tokenized stock) through the
 * v4 pool; the client handles the one-time approval on the first trade.
 */
export function BaseTradePanel({ token, initialSide }: { token: TokenSummary; initialSide?: Side }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);

  const [side, setSide] = useState<Side>(initialSide ?? "buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(8);
  const [showSettings, setShowSettings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pair, setPair] = useState<Pair | null>(null);
  const [pairBal, setPairBal] = useState<bigint | null>(null);
  const [coinBal, setCoinBal] = useState<bigint | null>(null);

  useEffect(() => {
    let live = true;
    (v4Client as any).basePairInfo(token.address).then((p: Pair) => live && setPair(p)).catch(() => undefined);
    return () => { live = false; };
  }, [token.address]);

  const refresh = async () => {
    if (!address || !pair) { setPairBal(null); setCoinBal(null); return; }
    try {
      // A WETH pair is paid as native ETH (the router wraps), so show ETH balance.
      const [pb, cb] = await Promise.all([
        isWeth(pair.address)
          ? client.publicClient.getBalance({ address })
          : client.publicClient.readContract({ address: pair.address, abi: launchTokenAbi, functionName: "balanceOf", args: [address] }),
        client.publicClient.readContract({ address: token.address, abi: launchTokenAbi, functionName: "balanceOf", args: [address] }),
      ]);
      setPairBal(pb as bigint);
      setCoinBal(cb as bigint);
    } catch { /* ignore */ }
  };
  useEffect(() => { refresh().catch(() => undefined); /* eslint-disable-next-line */ }, [address, token.address, pair]);

  const taxBps = Number(token.feeTier) || 100;
  const feeRate = taxBps / 10000;
  const priceUsd = Number(token.priceUsd) || 0;
  const pUsd = pair ? pairUsdOf(pair) : 0;

  const amtNum = useMemo(() => { const n = Number(amount); return isFinite(n) && n > 0 ? n : 0; }, [amount]);

  // USD-based estimate (a preview; the on-chain swap + slippage guard are exact).
  const est = useMemo(() => {
    if (!amtNum || !pair || priceUsd <= 0 || pUsd <= 0) return null;
    if (side === "buy") {
      const coinsOut = (amtNum * pUsd / priceUsd) * (1 - feeRate);
      return { out: coinsOut, symbol: token.symbol, usd: amtNum * pUsd };
    }
    const pairOut = (amtNum * priceUsd / pUsd) * (1 - feeRate);
    return { out: pairOut, symbol: disp(pair.address, pair.symbol), usd: amtNum * priceUsd };
  }, [amtNum, side, pair, priceUsd, pUsd, feeRate, token.symbol]);

  const payBal = side === "buy" ? pairBal : coinBal;
  const payDecimals = side === "buy" ? (pair?.decimals ?? 18) : 18;
  const payUsd = side === "buy" ? pUsd : priceUsd;
  const paySymbol = side === "buy" ? (pair ? disp(pair.address, pair.symbol) : "…") : token.symbol;
  const recvSymbol = side === "buy" ? token.symbol : (pair ? disp(pair.address, pair.symbol) : "…");

  // Position readout for the Balance / Value / PnL block (this coin's holding).
  const coinHeld = coinBal != null ? Number(formatUnits(coinBal, 18)) : null;
  const coinValueUsd = coinHeld != null && priceUsd > 0 ? coinHeld * priceUsd : null;

  const setPct = (pct: number) => {
    if (payBal == null) return;
    const usable = pct === 100 ? (payBal * 99n) / 100n : (payBal * BigInt(pct)) / 100n;
    setAmount(formatUnits(usable, payDecimals));
  };

  // Dollar quick-buy: set the pay amount to the pay-token value of `usd`.
  const setUsd = (usd: number) => {
    if (payUsd <= 0) return;
    const tokens = usd / payUsd;
    setAmount(tokens < 1 ? tokens.toPrecision(4).replace(/\.?0+$/, "") : tokens.toFixed(4).replace(/\.?0+$/, ""));
  };

  // Stepper: nudge the amount up/down by a sensible step for the pay token.
  const step = (dir: 1 | -1) => {
    const s = side === "buy" ? 0.01 : Math.max(1, Math.round((amtNum || 1) * 0.1));
    const next = Math.max(0, (amtNum || 0) + dir * s);
    setAmount(next === 0 ? "" : String(Number(next.toFixed(side === "buy" ? 4 : 2))));
  };

  const parsed = useMemo(() => {
    try { return amount ? parseUnits(amount as `${number}`, payDecimals) : 0n; } catch { return null; }
  }, [amount, payDecimals]);

  const insufficient = parsed != null && payBal != null && parsed > payBal;

  const submit = async () => {
    if (!parsed || parsed === 0n || !pair) return;
    setBusy(true);
    try {
      if (!(await ensureSdkWallet())) throw new Error("Wallet session expired. Reconnect and try again.");
      // Slippage floor in the receive token's units.
      let minOut = 0n;
      if (est) {
        const recvDec = side === "buy" ? 18 : pair.decimals;
        const floor = est.out * Math.max(0, 1 - slip / 100);
        minOut = BigInt(Math.max(0, Math.floor(floor * 10 ** recvDec)));
      }
      const hash = side === "buy"
        ? await v4Client.buyToken(token.address as Address, parsed, minOut)
        : await v4Client.sellToken(token.address as Address, parsed, minOut);
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await client.publicClient.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${side === "buy" ? "Buy" : "Sell"} confirmed`, txHash: hash });
      setAmount("");
      await refresh();
    } catch (err) {
      pushToast({ kind: "error", title: "Transaction failed", body: errorText(err) });
    } finally {
      setBusy(false);
    }
  };

  const dollarPresets = side === "buy" ? [10, 25, 50, 100] : null;

  return (
    <div className="tp">
      <div className="tp-swaphead">
        <span className="tp-swaptitle">Swap</span>
        <button className="tp-gear" aria-label="Settings" onClick={() => setShowSettings((v) => !v)}>
          <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
        </button>
      </div>

      <div className="tp-card">
        <div className="tp-seg">
          <button onClick={() => { setSide("buy"); setAmount(""); }} className={`buy ${side === "buy" ? "on" : ""}`}>Buy</button>
          <button onClick={() => { setSide("sell"); setAmount(""); }} className={`sell ${side === "sell" ? "on" : ""}`}>Sell</button>
        </div>

        <div className="tp-stats">
          <StatRow label="Balance" value={coinHeld != null ? `${compact(coinHeld)} ${token.symbol}` : "—"} />
          <StatRow label="Value" value={coinValueUsd != null ? fmtUsd(coinValueUsd) : "—"} />
          <StatRow label="PnL" value="—" />
        </div>

        <div className="tp-amtrow">
          <span className="tp-amtlabel">Amount</span>
          <div className="tp-amtfield">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))}
              placeholder="0.0"
              inputMode="decimal"
              className="tp-amtinput"
            />
            <span className="tp-stepper">
              <button aria-label="Increase" onClick={() => step(1)}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 15l6-6 6 6" /></svg>
              </button>
              <button aria-label="Decrease" onClick={() => step(-1)}>
                <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M6 9l6 6 6-6" /></svg>
              </button>
            </span>
            <span className="tp-amtunit">{paySymbol}</span>
          </div>
        </div>
        <div className="tp-approx">{est ? `≈ ${fmtUsd(est.usd)}` : "≈ $0"}</div>

        <div className="tp-presets">
          {dollarPresets
            ? dollarPresets.map((d) => (
                <button key={d} onClick={() => setUsd(d)} className="tp-preset">${d}</button>
              ))
            : [25, 50, 75, 100].map((p, i) => (
                <button key={p} onClick={() => setPct(p)} className="tp-preset">{["25%", "50%", "75%", "Max"][i]}</button>
              ))}
        </div>

        <div className="tp-payrow">
          <span className="tp-rowlabel">Pay with</span>
          <span className="tp-paysel">
            <EthMark />
            <span className="tp-paysym">ETH</span>
          </span>
        </div>

        <div className="tp-recvrow">
          <span className="tp-rowlabel">You receive</span>
          <span className="tp-recvval">{est ? `${compact(est.out)} ${recvSymbol}` : "—"}</span>
        </div>

        {showSettings ? (
          <div className="tp-slip">
            <span className="tp-rowlabel">Slippage</span>
            <div className="tp-slipbtns">
              {[3, 8, 15].map((p) => (
                <button key={p} onClick={() => setSlip(p)} className={slip === p ? "on" : ""}>{p}%</button>
              ))}
            </div>
          </div>
        ) : null}

        {isConnected ? (
          <button onClick={submit} disabled={busy || !parsed || parsed === 0n || Boolean(insufficient) || !pair} className={`tp-cta ${side}`}>
            {busy ? "Confirm in wallet" : insufficient ? "Insufficient balance" : side === "buy" ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
          </button>
        ) : (
          <button onClick={connectFirst} className="tp-cta connect">Connect to trade</button>
        )}
      </div>
    </div>
  );
}

/** ETH diamond mark for the fixed "Pay with" chip. */
function EthMark() {
  return (
    <svg viewBox="0 0 24 24" width="16" height="16" aria-hidden>
      <path d="M12 2 5.5 12.2 12 16l6.5-3.8Z" fill="#8aa0ff" />
      <path d="M12 2 5.5 12.2 12 9.1Z" fill="#c7d3ff" />
      <path d="M12 17.2 5.5 13.4 12 22l6.5-8.6Z" fill="#8aa0ff" />
    </svg>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="tp-statrow">
      <span className="tp-statlabel">{label}</span>
      <span className="tp-statval">{value}</span>
    </div>
  );
}
