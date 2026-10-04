import { useEffect, useMemo, useState } from "react";
import { useBalance, useWalletClient } from "wagmi";
import { parseEther, zeroAddress } from "viem";

import { confirmTx, ercAbi, factoryAbi, hookAbi, VENTURE, venturePc, type Venture as VentureT } from "../client";
import { capState, feePct, gradValueWei, priceImpactPct, quoteBuy, quoteSellWei } from "../curve";
import { Countdown, fmtEth, fmtTok, fmtUsdV, pct, useEthUsd, useTick } from "../ui";
import { useWallet, errorText } from "../../lib/useWallet";
import { useUi } from "../../store";
import { chainNowSecs } from "../clock";
import { GRADUATED_TOPIC, GRADUATING_BUY_GAS, Impact, LAUNCH_WINDOW_SECS, ReferralBanner } from "./shared";

/** The raise box: back this project on the curve. */
export function RaisePanel({ v }: { v: VentureT }) {
  useTick();
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [sellQ, setSellQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [spent, setSpent] = useState(0n);
  const [bought, setBought] = useState(0n);
  const [fees, setFees] = useState({ buyBps: 0, sellBps: 0 });
  const eth = useBalance({ address: me });

  useEffect(() => {
    const read = (fn: "curveBuyFeeBps" | "curveSellFeeBps") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn });
    Promise.all([read("curveBuyFeeBps"), read("curveSellFeeBps")])
      .then(([b, sl]) => setFees({ buyBps: Number(b), sellBps: Number(sl) })).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!me) return;
    const read = (fn: "spentWei" | "boughtTokens") =>
      venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: fn, args: [v.address, me] });
    read("spentWei").then((x) => setSpent(x)).catch(() => undefined);
    read("boughtTokens").then((x) => setBought(x)).catch(() => undefined);
  }, [me, v.address, busy]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);
  // How far the curve may move against you between the quote and the block.
  // 3% by default: in a launch's first minutes several buys can land together.
  const [slipBps, setSlipBps] = useState(300);
  // The entry fee comes off before the curve is quoted, so the tokens you get
  // are priced on what actually reaches the curve. Both derivations live in
  // curve.ts, where they are tested against the contract's own arithmetic.
  // A wallet with a bound referrer pays 10% less of the curve fees.
  const [referred, setReferred] = useState(false);
  useEffect(() => {
    if (!me) { setReferred(false); return; }
    venturePc.readContract({ address: VENTURE.hook, abi: hookAbi, functionName: "referrerOf", args: [me] })
      .then((r) => setReferred(r !== zeroAddress)).catch(() => undefined);
  }, [me, busy]);
  const { fee: entryFee, tokensOut } = quoteBuy(v, parsed, fees.buyBps, referred);
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  // Mirrors VentureFactory.LAUNCH_WINDOW_SECS: for the first minute every
  // wallet may put in at most 1% of the target.
  useTick();
  const now = chainNowSecs();
  const windowLeft = v.createdAt + LAUNCH_WINDOW_SECS - now;
  const windowCap = v.targetRaiseWei / 100n;
  const inWindow = windowLeft > 0;
  const effectiveCap = inWindow && windowCap < v.maxBuyWei ? windowCap : v.maxBuyWei;
  const { overCap } = capState(effectiveCap, spent, parsed);
  const shortOnEth = eth.data !== undefined && parsed > eth.data.value;
  const ethUsdInPanel = useEthUsd();

  const ownedWhole = bought / 10n ** 18n;
  const sellWhole = useMemo(() => {
    // Whole tokens, parsed as digits: Number() turns a long paste into
    // Infinity, which BigInt() throws on.
    const digits = sellQ.trim().split(".")[0].replace(/[^0-9]/g, "").slice(0, 40);
    const n = digits ? BigInt(digits) : 0n;
    return n > ownedWhole ? ownedWhole : n < 0n ? 0n : n;
  }, [sellQ, ownedWhole]);
  const sellQuote = useMemo(
    () => quoteSellWei(v, sellWhole, bought, spent, fees.sellBps, referred),
    [v, sellWhole, bought, spent, fees.sellBps, referred],
  );

  const buy = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      // The buy that fills the raise also creates the pool, about 6-7x a plain
      // buy's gas. A wallet estimate taken before someone else's buy lands
      // would be a plain buy's, and the tx would run out of gas if it turns out
      // to be the filling one, so near the line the limit covers graduation.
      // Only gas used is charged.
      const left = v.targetRaiseWei > v.raisedWei ? v.targetRaiseWei - v.raisedWei : 0n;
      const mayFill = funded >= 50 || parsed * 2n >= left;
      const hash = await wc.writeContract({
        address: VENTURE.factory, abi: factoryAbi, functionName: "buy",
        args: [v.address, (tokensOut * 10n ** 18n * BigInt(10_000 - slipBps)) / 10_000n], value: parsed,
        chain: wc.chain, account: wc.account, ...(mayFill ? { gas: GRADUATING_BUY_GAS } : {}),
      });
      pushToast({ kind: "info", title: "Buy sent", txHash: hash });
      const rc = await confirmTx(hash);
      const graduated = rc.logs.some((l) => l.topics[0] === GRADUATED_TOPIC);
      pushToast({ kind: "success", title: graduated ? "Bought. That filled the curve, so it trades on Uniswap now." : "Bought", txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Buy failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const sell = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || sellWhole === 0n) return;
    setBusy(true);
    try {
      const need = sellWhole * 10n ** 18n;
      const allowance = (await venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "allowance", args: [wc.account.address, VENTURE.factory] }));
      if (allowance < need) {
        const a = await wc.writeContract({ address: v.address, abi: ercAbi, functionName: "approve", args: [VENTURE.factory, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
        await confirmTx(a);
      }
      const minOut = (sellQuote.out * BigInt(10_000 - slipBps)) / 10_000n;
      const hash = await wc.writeContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "sell", args: [v.address, sellWhole, minOut], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Sell sent", txHash: hash });
      await confirmTx(hash);
      pushToast({ kind: "success", title: "Sold back to the curve", txHash: hash });
      setSellQ("");
    } catch (e) {
      pushToast({ kind: "error", title: "Sell failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  const guaranteed = v.mode === 0;

  return (
    <div className="dp-panel dp-tradebox">
      <div className="dp-tb-tabs">
        <button className={`dp-buy ${side === "buy" ? "on" : ""}`} onClick={() => setSide("buy")}>
          Buy
        </button>
        <button className={`dp-sell ${side === "sell" ? "on" : ""}`} onClick={() => setSide("sell")}>Sell</button>
      </div>
      <div className="dp-tb-body">
        <ReferralBanner />
        {side === "buy" ? (
          <>
            <div className="dp-tb-amt">
              <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
              <span>ETH</span>
            </div>
            <div className="dp-quicks">
              {["0.05", "0.1", "0.5", "1"].map((q) => <button key={q} onClick={() => setAmt(q)}>{q}</button>)}
            </div>
            <p className="dp-tb-est">
              {tokensOut > 0n ? <>you receive ≈ <b>{fmtTok(tokensOut, true)} ${v.symbol}</b><Impact curve pct={priceImpactPct("buy", parsed - entryFee, tokensOut * 10n ** 18n, v.priceWei, 0)} /></> : <>enter an amount to see what you get</>}
            </p>
            <button className="dp-tb-go dp-buy"
              disabled={busy || overCap || shortOnEth || (isConnected && parsed === 0n)} onClick={buy}>
              {busy ? "Confirm in wallet…"
                : !isConnected ? "Connect wallet"
                : shortOnEth ? "Not enough ETH"
                : overCap ? (inWindow ? `First minute: max ${fmtEth(windowCap, 4)} ETH` : "Over your wallet cap")
                : `Buy $${v.symbol}`}
            </button>
            <div className="dp-tb-slip">
              <span>balance <b style={{ color: "var(--dim)" }}>{eth.data ? fmtEth(eth.data.value, 4) : "—"} ETH</b></span>
              <span>entry fee {feePct(fees.buyBps)}%{entryFee > 0n ? ` · ${fmtEth(entryFee, 5)} ETH` : ""}</span>
            </div>
          </>
        ) : (
          <>
            <div className="dp-tb-amt">
              <input inputMode="numeric" placeholder="0" value={sellQ} onChange={(e) => setSellQ(e.target.value.replace(/[^0-9]/g, ""))} />
              <span>${v.symbol}</span>
            </div>
            <div className="dp-quicks">
              {([["25%", 4n], ["50%", 2n], ["Max", 1n]] as const).map(([label, div]) => (
                <button key={label} onClick={() => setSellQ(String(ownedWhole / div))}>{label}</button>
              ))}
            </div>
            <p className="dp-tb-est">
              {sellQuote.out > 0n
                ? <>you receive ≈ <b>{fmtEth(sellQuote.out, 5)} ETH</b></>
                : <>you hold {fmtTok(bought)} ${v.symbol} from the curve</>}
            </p>
            <button className="dp-tb-go dp-sell"
              disabled={busy || (isConnected && sellWhole === 0n)} onClick={sell}>
              {busy ? "Confirm in wallet…" : !isConnected ? "Connect wallet" : `Sell ${fmtTok(sellWhole, true)} $${v.symbol}`}
            </button>
            <div className="dp-tb-slip">
              <span>you hold <b style={{ color: "var(--dim)" }}>{fmtTok(bought)}</b></span>
              <span>exit fee {feePct(fees.sellBps)}%</span>
            </div>
          </>
        )}
        <div className="dp-tb-slip">
          <label style={{ display: "flex", gap: 6, alignItems: "center" }}>
            max slippage
            <select value={slipBps} onChange={(e) => setSlipBps(Number(e.target.value))} className="dp-slip">
              <option value={100}>1%</option>
              <option value={300}>3%</option>
              <option value={500}>5%</option>
              <option value={1000}>10%</option>
            </select>
          </label>
          <span>{side === "buy" && tokensOut > 0n ? `at least ${fmtTok((tokensOut * BigInt(10_000 - slipBps)) / 10_000n, true)} $${v.symbol}` : ""}</span>
        </div>
        {inWindow && (
          <p className="dp-tb-note" style={{ marginTop: 0 }}>
            Just launched: for the next {windowLeft}s each wallet can put in at most {fmtEth(windowCap, 4)} ETH.
          </p>
        )}
        <div className="dp-tb-slip">
          <span>{guaranteed ? <>closes in <Countdown deadline={v.deadline} /></> : <>no deadline</>}</span>
          <span>{ethUsdInPanel > 0 && parsed > 0n && side === "buy" ? fmtUsdV((Number(parsed) / 1e18) * ethUsdInPanel) : ""}</span>
        </div>
        <p className="dp-tb-note">
          {side === "buy" && tokensOut > 0n ? (() => {
            // Both outcomes, in numbers, before anyone signs.
            const atGrad = gradValueWei(v, tokensOut);
            const x = Number(atGrad) / Number(parsed);
            return <>
              If it graduates: worth <b>≈ {fmtEth(atGrad, 4)} ETH</b> when trading opens{x >= 1.05 ? ` (${x.toFixed(x < 10 ? 1 : 0)}×)` : ""}.{" "}
              {guaranteed
                ? <>If it misses: <b>{fmtEth(parsed - entryFee, 4)} ETH</b> back.</>
                : <>Open curve: no refund, sell back any time.</>}
            </>;
          })()
            : side === "sell" && guaranteed
            ? "Sell back any time before graduation, for at most what you paid."
            : side === "sell"
            ? "Sell back any time at the curve price."
            : guaranteed
            ? "If it misses its target, you get your ETH back."
            : "Graduates when the curve fills. No refunds."}
        </p>
      </div>
    </div>
  );
}
