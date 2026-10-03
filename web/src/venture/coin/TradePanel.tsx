import { useEffect, useMemo, useState } from "react";
import { useBalance, useWalletClient } from "wagmi";
import { formatEther, parseEther } from "viem";

import { confirmTx, ercAbi, routerAbi, VENTURE, venturePc, type Venture as VentureT } from "../client";
import { feePct, priceImpactPct, taxPct } from "../curve";
import { fmtEth, fmtTok } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";
import { Impact, ReferralBanner } from "./shared";

/** Post-graduation: ETH buy/sell through the router + dividend claim. */
export function TradePanel({ v }: { v: VentureT }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [bal, setBal] = useState(0n);
  const [pending, setPending] = useState(0n);
  const [slipBps, setSlipBps] = useState(100);
  const [quote, setQuote] = useState<bigint | null>(null);
  const [quoting, setQuoting] = useState(false);
  const eth = useBalance({ address: me });

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = () => {
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "balanceOf", args: [me] }).then((x) => live && setBal(x as bigint)).catch(() => undefined);
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).then((x) => live && setPending(x as bigint)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me, v.address]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);

  // The router returns what a trade would produce, so the quote and the
  // slippage floor are both real rather than decorative.
  useEffect(() => {
    if (parsed === 0n) { setQuote(null); return; }
    let live = true;
    setQuoting(true);
    const id = setTimeout(() => {
      const account = me ?? VENTURE.router;
      const sim = side === "buy"
        ? venturePc.simulateContract({ address: VENTURE.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", 0n], value: parsed, account })
        : venturePc.simulateContract({ address: VENTURE.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", 0n], account });
      sim.then((r) => { if (live) setQuote(r.result as bigint); })
        .catch(() => { if (live) setQuote(null); })
        .finally(() => { if (live) setQuoting(false); });
    }, 350);
    return () => { live = false; clearTimeout(id); };
  }, [parsed, side, v.address, me]);

  const minOut = quote !== null ? (quote * BigInt(10_000 - slipBps)) / 10_000n : 0n;
  const shortOnEth = side === "buy" && eth.data !== undefined && parsed > eth.data.value;
  const shortOnTokens = side === "sell" && parsed > bal;

  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      let hash: `0x${string}`;
      if (side === "buy") {
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", minOut], value: parsed, chain: wc.chain, account: wc.account });
      } else {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account!.address, VENTURE.router] })) as bigint;
        if (allowance < parsed) {
          const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.router, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await confirmTx(a);
        }
        hash = await wc.writeContract({ address: VENTURE.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", minOut], chain: wc.chain, account: wc.account });
      }
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await confirmTx(hash);
      pushToast({ kind: "success", title: `${side === "buy" ? "Buy" : "Sell"} confirmed`, txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Trade failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const claim = async () => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "ETH drip claimed", txHash: hash });
      setPending(0n);
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const tax = side === "buy" ? v.policy.buyTaxBps : v.policy.sellTaxBps;
  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmt(""); }}>Buy</button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmt(""); }}>Sell</button>
      </div>
      <div className="dp-tb-body">
        <ReferralBanner />
        <div className="dp-tb-amt">
          <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
          <span>{side === "buy" ? "ETH" : `$${v.symbol}`}</span>
        </div>
        <div className="dp-quicks">
          {side === "buy"
            ? ["0.05", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)
            : ["25%", "50%", "75%", "max"].map((q, i) => (
              <button key={q} onClick={() => setAmt(formatEther(bal * BigInt([25, 50, 75, 100][i]) / 100n))}>{q}</button>
            ))}
        </div>
        <p className="dp-tb-est">
          {parsed === 0n ? <span style={{ color: "var(--faint)" }}>Enter an amount to see what you get.</span>
            : quoting ? <span style={{ color: "var(--faint)" }}>Quoting…</span>
            : quote === null ? <span style={{ color: "var(--down)" }}>Could not quote this trade.</span>
            : side === "buy" ? <>you receive ≈ <b>{fmtTok(quote)} ${v.symbol}</b><Impact pct={priceImpactPct("buy", parsed, quote, v.priceWei, tax + VENTURE.platformFeeBps)} /></>
            : <>you receive ≈ <b>{fmtEth(quote, 6)} ETH</b><Impact pct={priceImpactPct("sell", parsed, quote, v.priceWei, tax + VENTURE.platformFeeBps)} /></>}
        </p>
        <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`}
          disabled={busy || shortOnEth || shortOnTokens || (isConnected && (parsed === 0n || quote === null))} onClick={go}>
          {busy ? "Confirm in wallet…"
            : !isConnected ? "Connect wallet"
            : shortOnEth ? "Not enough ETH"
            : shortOnTokens ? `Not enough $${v.symbol}`
            : `${side === "buy" ? "Buy" : "Sell"} $${v.symbol}`}
        </button>
        <div className="dp-tb-slip">
          <span>
            balance{" "}
            <b style={{ color: "var(--dim)" }}>
              {side === "buy" ? `${eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH` : `${fmtTok(bal)} $${v.symbol}`}
            </b>
          </span>
          <span>fee {taxPct(tax)}% + {feePct(VENTURE.platformFeeBps)}%</span>
        </div>
        <div className="dp-tb-slip">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            max slippage
            <select value={slipBps} onChange={(e) => setSlipBps(Number(e.target.value))} className="dp-slip">
              <option value={50}>0.5%</option>
              <option value={100}>1%</option>
              <option value={300}>3%</option>
              <option value={500}>5%</option>
            </select>
          </label>
          <span>{quote !== null ? <>min received {side === "buy" ? `${fmtTok(minOut)} $${v.symbol}` : `${fmtEth(minOut, 6)} ETH`}</> : ""}</span>
        </div>

        {isConnected && pending > 0n && (
          <div className="dp-chit" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span>your ETH drip<br /><b style={{ color: "var(--up)", fontFamily: "var(--mono)" }}>{fmtEth(pending, 6)} ETH</b></span>
            <button className="dp-action" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy} onClick={claim}>Claim</button>
          </div>
        )}
      </div>
    </div>
  );
}
