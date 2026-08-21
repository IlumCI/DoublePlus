import { useEffect, useMemo, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import { launchTokenAbi, type Address, type TokenSummary } from "@launchpad/sdk";

import { client, v4Client } from "../lib/client";
import { fmtUsd, compact } from "../lib/format";
import { BASE_USDC, BASE_WETH, baseStockUsd } from "../lib/base/routes";
import { baseStockOf } from "../lib/base/stocks";
import { ensureSdkWallet, errorText, useWallet } from "../lib/useWallet";
import { useUi } from "../store";
import { TokenLogo } from "./TokenLogo";

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
 * Pair-denominated trade desk for the Base stock launchpad. A coin trades
 * against its own pair token — USDC or a tokenized stock — through the coin's
 * v4 pool (StockTradeRouter). You pay/receive the pair token, not ETH. The
 * client handles the one-time token approval on the first trade.
 */
export function BaseTradePanel({ token, initialSide }: { token: TokenSummary; initialSide?: Side }) {
  const { address, isConnected, connectFirst } = useWallet();
  const pushToast = useUi((s) => s.pushToast);

  const [side, setSide] = useState<Side>(initialSide ?? "buy");
  const [amount, setAmount] = useState("");
  const [slip, setSlip] = useState(8);
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
  const paySymbol = side === "buy" ? (pair ? disp(pair.address, pair.symbol) : "…") : token.symbol;
  const recvSymbol = side === "buy" ? token.symbol : (pair ? disp(pair.address, pair.symbol) : "…");

  const setPct = (pct: number) => {
    if (payBal == null) return;
    const usable = pct === 100 ? (payBal * 99n) / 100n : (payBal * BigInt(pct)) / 100n;
    setAmount(formatUnits(usable, payDecimals));
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

  return (
    <div className="tp">
      <div className="term-head">
        Trade desk
        <span className="term-head-sub">pays {pair ? disp(pair.address, pair.symbol) : "the pair"} · {(feeRate * 100).toFixed(taxBps % 100 ? 1 : 0)}% fee</span>
      </div>
      <div className="tp-body">
        <div className="tp-seg">
          <button onClick={() => { setSide("buy"); setAmount(""); }} className={`buy ${side === "buy" ? "on" : ""}`}>Buy</button>
          <button onClick={() => { setSide("sell"); setAmount(""); }} className={`sell ${side === "sell" ? "on" : ""}`}>Sell</button>
        </div>

        {/* Pay */}
        <div className="tp-field">
          <div className="mb-1.5 flex items-baseline justify-between text-[10.5px]">
            <span className="uppercase tracking-wide text-ink-3">You pay</span>
            <button className="tnum text-ink-3 transition-colors hover:text-ink" onClick={() => setPct(100)}>
              Balance {payBal != null ? compact(Number(formatUnits(payBal, payDecimals))) : "0"}
            </button>
          </div>
          <div className="flex items-center gap-2">
            <input value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^0-9.]/g, ""))} placeholder="0.0" inputMode="decimal"
              className="mono min-w-0 flex-1 bg-transparent text-[22px] font-semibold text-ink outline-none placeholder:text-ink-3/60" />
            <span className="tp-chip">
              {side === "buy" ? <StockDot sym={paySymbol} /> : <TokenLogo token={token} size={20} />}
              <span className="text-[13px] font-bold text-ink">{paySymbol}</span>
            </span>
          </div>
          <div className="mono mt-1 h-3.5 text-[11px] text-ink-3">{est && side === "buy" ? `≈ ${fmtUsd(est.usd)}` : est && side === "sell" ? `≈ ${fmtUsd(est.usd)}` : ""}</div>
        </div>

        {/* Presets */}
        <div className="grid grid-cols-4 gap-1.5">
          {(side === "sell" ? ["25%", "50%", "75%", "Max"] : ["25%", "50%", "75%", "Max"]).map((v, i) => (
            <button key={v} onClick={() => setPct([25, 50, 75, 100][i])} className="tp-preset tnum">{v}</button>
          ))}
        </div>

        {/* Receive */}
        <div className="tp-field">
          <div className="mb-1.5 text-[10.5px] uppercase tracking-wide text-ink-3">You receive (est.)</div>
          <div className="flex items-center gap-2">
            <span className="mono min-w-0 flex-1 truncate text-[22px] font-semibold text-ink">{est ? compact(est.out) : "0.0"}</span>
            <span className="tp-chip">
              {side === "buy" ? <TokenLogo token={token} size={20} /> : <StockDot sym={recvSymbol} />}
              <span className="text-[13px] font-bold text-ink">{recvSymbol}</span>
            </span>
          </div>
        </div>

        <div className="tp-rows">
          <Row label="Price" value={priceUsd > 0 ? `${fmtUsd(priceUsd)} / ${token.symbol}` : "–"} />
          <Row label="Reward" value={pair ? `holders earn ${disp(pair.address, pair.symbol)}` : "–"} />
          <Row label="Trade fee" value={`${(feeRate * 100).toFixed(taxBps % 100 ? 1 : 0)}%`} />
          <div className="flex items-center justify-between pt-0.5">
            <span className="text-ink-3">Slippage</span>
            <div className="flex items-center gap-1">
              {[3, 8, 15].map((p) => (
                <button key={p} onClick={() => setSlip(p)} className={`tnum rounded px-1.5 py-0.5 transition-colors ${slip === p ? "bg-accent/15 font-semibold text-accent-ink" : "text-ink-3 hover:text-ink"}`}>{p}%</button>
              ))}
            </div>
          </div>
        </div>

        {isConnected ? (
          <button onClick={submit} disabled={busy || !parsed || parsed === 0n || Boolean(insufficient) || !pair} className={`tp-cta ${side}`}>
            {busy ? "Confirm in wallet" : insufficient ? "Insufficient balance" : side === "buy" ? `Buy ${token.symbol}` : `Sell ${token.symbol}`}
          </button>
        ) : (
          <button onClick={connectFirst} className="tp-cta buy">Connect wallet</button>
        )}
      </div>
    </div>
  );
}

/** Small ticker chip for the pair stock (no external logo dependency). */
function StockDot({ sym }: { sym: string }) {
  return (
    <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full text-[8px] font-extrabold"
      style={{ background: "var(--color-panel-2, #1a2233)", color: "var(--nb-blue, #4d7cff)" }}>
      {sym.slice(0, 2)}
    </span>
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
