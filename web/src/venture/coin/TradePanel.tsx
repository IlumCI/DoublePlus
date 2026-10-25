import { useEffect, useMemo, useState } from "react";
import { useBalance, useWalletClient } from "wagmi";
import { formatEther, parseEther, zeroAddress, type Hex } from "viem";

import { confirmTx, ercAbi, limitAbi, payoutsAbi, placedEvent, routerAbi, VENTURE, venturePc, type PoolTrade, type Venture as VentureT, sendTx, allowanceSlot, balanceSlot, MAX_ALLOWANCE, pad32 } from "../client";
import { choiceFor, payoutChoices } from "../payouts";
import { feePct, priceImpactPct, taxPct } from "../curve";
import { marketStats } from "../marketStats";
import { chainNowSecs } from "../clock";
import { dailyDividendsWei, tierIndex, tierRows } from "../tiers";
import { fmtEth, fmtTok, fmtUsdV } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";
import { Impact, bindReferral } from "./shared";

// Any plain address can price a sell before a wallet connects.
const QUOTE_WALLET = "0x000000000000000000000000000000000000dEaD" as const;

/** Post-graduation: ETH buy/sell through the router + dividend claim. */
export function TradePanel({ v, trades, ethUsd }: { v: VentureT; trades: PoolTrade[]; ethUsd: number }) {
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
  const [limit, setLimit] = useState(false);
  const [atMcap, setAtMcap] = useState("");
  const [ordersTick, setOrdersTick] = useState(0);
  const hasLimit = v.sys.limitOrders !== zeroAddress;
  const eth = useBalance({ address: me });

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = () => {
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "balanceOf", args: [me] }).then((x) => live && setBal(x)).catch(() => undefined);
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).then((x) => live && setPending(x)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me, v.address]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);

  // The router returns what a trade would produce, so the quote and the
  // slippage floor are both real rather than decorative.
  useEffect(() => {
    // Dropped first: minOut comes from the quote, and one priced for the last
    // amount or side would set the wrong floor if sent before this one lands.
    setQuote(null);
    if (parsed === 0n) return;
    let live = true;
    setQuoting(true);
    const id = setTimeout(() => {
      const account = me ?? v.sys.router;
      const seller = me ?? QUOTE_WALLET;
      const sim = side === "buy"
        ? venturePc.simulateContract({ address: v.sys.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", 0n], value: parsed, account })
        : venturePc.simulateContract({
          address: v.sys.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", 0n], account: seller,
          // Priced as if the router were already approved (and, before a
          // wallet connects, as if the amount were held), so the quote shows
          // before the approval the sell itself asks for.
          stateOverride: [{ address: v.address, stateDiff: [
            { slot: allowanceSlot(seller, v.sys.router), value: MAX_ALLOWANCE },
            ...(me ? [] : [{ slot: balanceSlot(seller), value: pad32(parsed) }]),
          ] }],
        });
      sim.then((r) => { if (live) setQuote(r.result); })
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
      await bindReferral(wc, pushToast, v.sys.hook);
      let hash: `0x${string}`;
      if (side === "buy") {
        hash = await sendTx(wc, { address: v.sys.router, abi: routerAbi, functionName: "buy", args: [v.address, "0x", minOut], value: parsed, chain: wc.chain, account: wc.account });
      } else {
        const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account.address, v.sys.router] }));
        if (allowance < parsed) {
          const a = await sendTx(wc, { address: v.address, abi: ercAbi, functionName: "approve", args: [v.sys.router, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await confirmTx(a);
        }
        hash = await sendTx(wc, { address: v.sys.router, abi: routerAbi, functionName: "sell", args: [v.address, parsed, "0x", minOut], chain: wc.chain, account: wc.account });
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
      const hash = await sendTx(wc, { address: v.address, abi: ercAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "ETH drip claimed", txHash: hash });
      setPending(0n);
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const tax = side === "buy" ? v.policy.buyTaxBps : v.policy.sellTaxBps;
  // Limit orders are priced by market cap: the number traders actually watch.
  const usd = ethUsd > 0;
  const mcapNow = (Number(v.priceWei) / 1e18) * 1e9 * (usd ? ethUsd : 1);
  const target = Number(atMcap) || 0;
  const limitMinOut = (() => {
    if (!limit || target <= 0 || parsed === 0n) return 0n;
    const priceEth = target / (usd ? ethUsd : 1) / 1e9;
    const keep = 1 - (tax + VENTURE.platformFeeBps) / 10_000;
    const amount = Number(parsed) / 1e18;
    const out = side === "buy" ? (amount * keep) / priceEth : amount * priceEth * keep;
    return BigInt(Math.floor(out * 1e18));
  })();
  // An order fills whole or not at all, so it waits until the *entire* trade
  // clears its floor. A large order in a thin pool moves the price, so it
  // fills further out than the market cap typed: show where, from the same
  // simulated quote the market tab uses.
  const impact = (() => {
    if (quote === null || parsed === 0n || mcapNow <= 0) return 0;
    const spotPriceEth = Number(v.priceWei) / 1e18;
    const keep = 1 - (tax + VENTURE.platformFeeBps) / 10_000;
    const amount = Number(parsed) / 1e18;
    const spotOut = side === "buy" ? (amount * keep) / spotPriceEth : amount * spotPriceEth * keep;
    return spotOut > 0 ? Math.max(0, 1 - Number(quote) / 1e18 / spotOut) : 0;
  })();
  const triggerMcap = target > 0 && impact < 0.95 ? (side === "sell" ? target / (1 - impact) : target * (1 - impact)) : 0;
  const placeLimit = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || limitMinOut === 0n) return;
    setBusy(true);
    try {
      await bindReferral(wc, pushToast, v.sys.hook);
      if (side === "sell") {
        const allowance = await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account.address, v.sys.limitOrders] });
        if (allowance < parsed) {
          const a = await sendTx(wc, { address: v.address, abi: ercAbi, functionName: "approve", args: [v.sys.limitOrders, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await confirmTx(a);
        }
      }
      const hash = await sendTx(wc, {
        address: v.sys.limitOrders, abi: limitAbi, functionName: "place",
        args: [v.address, side === "buy", side === "buy" ? 0n : parsed, limitMinOut, 25, 0n],
        value: side === "buy" ? parsed : 0n, chain: wc.chain, account: wc.account,
      });
      await confirmTx(hash);
      pushToast({ kind: "success", title: `Limit ${side} placed`, txHash: hash });
      setAmt(""); setAtMcap(""); setOrdersTick((n) => n + 1);
    } catch (e) {
      pushToast({ kind: "error", title: "Order failed", body: errorText(e) });
    } finally { setBusy(false); }
  };
  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => { setSide("buy"); setAmt(""); }}>Buy</button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => { setSide("sell"); setAmt(""); }}>Sell</button>
      </div>
      <div className="dp-tb-body">
        {hasLimit && (
          <div className="dp-tb-mode">
            <button className={!limit ? "on" : ""} onClick={() => setLimit(false)}>market</button>
            <button className={limit ? "on" : ""} onClick={() => setLimit(true)}>limit</button>
          </div>
        )}
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
        {limit && (
          <div className="dp-tb-amt dp-tb-at">
            <input inputMode="decimal" placeholder={mcapNow > 0 ? (usd ? mcapNow.toFixed(0) : mcapNow.toFixed(2)) : "0"} value={atMcap}
              onChange={(e) => setAtMcap(e.target.value.replace(/[^0-9.]/g, ""))} aria-label="market cap" />
            <span>{usd ? "$ mcap" : "ETH mcap"}</span>
          </div>
        )}
        {limit ? (
          <>
            <p className="dp-tb-est">
              {limitMinOut === 0n ? <span style={{ color: "var(--faint)" }}>now {usd ? fmtUsdV(mcapNow) : `${mcapNow.toFixed(2)} ETH`}</span>
                : side === "buy" ? <>at least <b>{fmtTok(limitMinOut)} ${v.symbol}</b></>
                : <>at least <b>{fmtEth(limitMinOut, 6)} ETH</b></>}
              {limitMinOut > 0n && impact >= 0.02 && triggerMcap > 0 && <><br />
                fills near <b>{usd ? fmtUsdV(triggerMcap) : `${triggerMcap.toFixed(2)} ETH`}</b> mcap: this size moves the price {(impact * 100).toFixed(0)}%</>}
            </p>
            <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`}
              disabled={busy || shortOnEth || shortOnTokens || (isConnected && limitMinOut === 0n)} onClick={placeLimit}>
              {busy ? "Confirm in wallet…" : !isConnected ? "Connect wallet"
                : shortOnEth ? "Not enough ETH" : shortOnTokens ? `Not enough $${v.symbol}`
                : limitMinOut === 0n ? "Set an amount and a price" : `Limit ${side} $${v.symbol}`}
            </button>
          </>
        ) : <>
        <p className="dp-tb-est">
          {parsed === 0n ? <span style={{ color: "var(--faint)" }}>Enter an amount to see what you get.</span>
            : quoting ? <span style={{ color: "var(--faint)" }}>Quoting…</span>
            : quote === null ? <span style={{ color: "var(--down)" }}>Could not quote this trade.</span>
            : side === "buy" ? <>you receive ≈ <b>{fmtTok(quote)} ${v.symbol}</b><Impact pct={priceImpactPct("buy", parsed, quote, v.priceWei, tax + VENTURE.platformFeeBps)} /></>
            : <>you receive ≈ <b>{fmtEth(quote, 6)} ETH</b><Impact pct={priceImpactPct("sell", parsed, quote, v.priceWei, tax + VENTURE.platformFeeBps)} /></>}
        </p>
        <button className={`dp-tb-go ${side === "buy" ? "dp-buy" : "dp-sell"}`}
          disabled={busy || (isConnected && quoting) || shortOnEth || shortOnTokens || (isConnected && (parsed === 0n || quote === null))} onClick={go}>
          {busy ? "Confirm in wallet…"
            : !isConnected ? "Connect wallet"
            : shortOnEth ? "Not enough ETH"
            : shortOnTokens ? `Not enough $${v.symbol}`
            : parsed === 0n ? "Enter an amount"
            : quoting ? "Quoting…"
            : quote === null ? "No price for this trade"
            : `${side === "buy" ? "Buy" : "Sell"} $${v.symbol}`}
        </button>
        </>}
        <div className="dp-tb-slip">
          <span>
            balance{" "}
            <b style={{ color: "var(--dim)" }}>
              {side === "buy" ? `${eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH` : `${fmtTok(bal)} $${v.symbol}`}
            </b>
          </span>
          <span>fee {taxPct(tax)}% + {feePct(VENTURE.platformFeeBps)}%</span>
        </div>
        <div className="dp-tb-slip" hidden={limit}>
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
        {hasLimit && isConnected && me && <MyOrders v={v} me={me} tick={ordersTick} />}

        {isConnected && pending > 0n && (
          <div className="dp-chit" style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 10 }}>
            <span>your ETH drip<br /><b style={{ color: "var(--up)", fontFamily: "var(--mono)" }}>{fmtEth(pending, 6)} ETH</b></span>
            <button className="dp-action" style={{ padding: "8px 14px", fontSize: 11 }} disabled={busy} onClick={claim}>Claim</button>
          </div>
        )}
        <TierPyramid v={v} trades={trades} ethUsd={ethUsd} bal={isConnected ? bal : 0n} />
      </div>
    </div>
  );
}

/** Tiered-dividend coins: the seven steps, what each takes to hold and what it
 *  would earn a day at the last 24h of volume. Moves with the volume. */
function TierPyramid({ v, trades, ethUsd, bal }: { v: VentureT; trades: PoolTrade[]; ethUsd: number; bal: bigint }) {
  const [tok, setTok] = useState<{ floor: bigint; eligible: bigint } | null>(null);
  useEffect(() => {
    if (v.policy.dividendBps === 0) return;
    let live = true;
    const read = (functionName: "minHoldForDividends" | "dividendMode" | "eligibleSupply") =>
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName }) as Promise<bigint | number>;
    const refresh = () =>
      Promise.all([read("minHoldForDividends"), read("dividendMode"), read("eligibleSupply")])
        .then(([floor, mode, eligible]) => live && setTok(Number(mode) === 1 ? { floor: BigInt(floor), eligible: BigInt(eligible) } : null))
        .catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [v.address, v.policy.dividendBps]);

  const st = useMemo(() => marketStats(trades, chainNowSecs()), [trades]);
  if (!tok || tok.floor === 0n) return null;
  const rows = tierRows(tok.floor, tok.eligible, dailyDividendsWei(st.buyVol24Wei, st.sellVol24Wei, v.policy));
  const mine = tierIndex(bal, tok.floor);
  const money = (wei: bigint) => ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 5)} ETH`;
  return (
    <div className="dp-tiers">
      <div className="dp-tiers-head"><span>tiers</span><span>hold</span><span>/ day</span></div>
      {mine >= 4 && v.sys.payouts !== zeroAddress && <PayoutPick v={v} />}
      {rows.map((r, i) => (
        <div key={r.mult} className={`dp-tier${rows.length - 1 - i === mine ? " on" : ""}`}>
          <span className="dp-tier-bar"><i style={{ width: `${34 + i * 11}%` }}>{r.mult}x</i></span>
          <span>{fmtTok(r.holdWei)}</span>
          <b>{money(r.dailyWei)}</b>
        </div>
      ))}
    </div>
  );
}

/** Open limit orders of this wallet on this coin, each with a cancel. */
function MyOrders({ v, me, tick }: { v: VentureT; me: `0x${string}`; tick: number }) {
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [orders, setOrders] = useState<{ id: bigint; isBuy: boolean; amountIn: bigint; minOut: bigint }[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    const load = async () => {
      const logs = await venturePc.getLogs({ address: v.sys.limitOrders, event: placedEvent, args: { owner: me, coin: v.address }, fromBlock: v.sys.startBlock, toBlock: "latest" });
      const open = await Promise.all(logs.map(async (l) => {
        const o = await venturePc.readContract({ address: v.sys.limitOrders, abi: limitAbi, functionName: "order", args: [l.args.id!] });
        return { id: l.args.id!, isBuy: o.isBuy, amountIn: o.amountIn, minOut: o.minOut };
      }));
      if (live) setOrders(open.filter((o) => o.amountIn > 0n));
    };
    load().catch(() => undefined);
    const id = setInterval(() => load().catch(() => undefined), 20_000);
    return () => { live = false; clearInterval(id); };
  }, [v.address, me, tick, busy]);
  if (!orders.length) return null;
  const cancel = async (id: bigint) => {
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await sendTx(wc, { address: v.sys.limitOrders, abi: limitAbi, functionName: "cancel", args: [id], chain: wc.chain, account: wc.account });
      await confirmTx(hash);
    } catch (e) {
      pushToast({ kind: "error", title: "Cancel failed", body: errorText(e) });
    } finally { setBusy(false); }
  };
  return (
    <div className="dp-orders">
      {orders.map((o) => (
        <div key={String(o.id)}>
          <span style={{ color: o.isBuy ? "var(--up)" : "var(--down)" }}>{o.isBuy ? "buy" : "sell"}</span>
          <span>{o.isBuy ? `${fmtEth(o.amountIn, 4)} ETH` : `${fmtTok(o.amountIn)} $${v.symbol}`}</span>
          <span>→ {o.isBuy ? `${fmtTok(o.minOut)} $${v.symbol}` : `${fmtEth(o.minOut, 5)} ETH`}</span>
          <button disabled={busy} onClick={() => cancel(o.id)}>cancel</button>
        </div>
      ))}
    </div>
  );
}

/** 5x holders choose what their dividends arrive as. */
function PayoutPick({ v }: { v: VentureT }) {
  const { address: me } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const choices = useMemo(() => payoutChoices(v.symbol), [v.symbol]);
  const [current, setCurrent] = useState<string>("eth");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!me) return;
    let live = true;
    Promise.all([
      venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "payoutAgent", args: [me] }),
      venturePc.readContract({ address: v.sys.payouts, abi: payoutsAbi, functionName: "prefOf", args: [me] }),
    ]).then(([agent, [kind, path]]) => {
      if (!live) return;
      setCurrent(agent.toLowerCase() === v.sys.payouts.toLowerCase() ? choiceFor(choices, kind, path as Hex).key : "eth");
    }).catch(() => undefined);
    return () => { live = false; };
  }, [me, v.address, choices, busy]);
  const pick = async (key: string) => {
    const c = choices.find((x) => x.key === key);
    if (!c || !wc || !me) return;
    setBusy(true);
    try {
      const agent = await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "payoutAgent", args: [me] });
      if (agent.toLowerCase() !== v.sys.payouts.toLowerCase()) {
        await confirmTx(await sendTx(wc, { address: v.address, abi: ercAbi, functionName: "setPayoutAgent", args: [v.sys.payouts], chain: wc.chain, account: wc.account }));
      }
      await confirmTx(await sendTx(wc, { address: v.sys.payouts, abi: payoutsAbi, functionName: "setPref", args: [c.kind, c.path], chain: wc.chain, account: wc.account }));
      setCurrent(key);
    } catch (e) {
      pushToast({ kind: "error", title: "Couldn't set payout", body: errorText(e) });
    } finally { setBusy(false); }
  };
  return (
    <label className="dp-payout">
      paid in
      <select value={current} disabled={busy} onChange={(e) => pick(e.target.value)}>
        {choices.map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
      </select>
    </label>
  );
}
