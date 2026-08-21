import { useEffect, useMemo, useState, type CSSProperties } from "react";
import { Link, useParams } from "react-router-dom";
import { useWalletClient } from "wagmi";
import { parseEther, type Address } from "viem";

import {
  AUCTION_SUPPLY, ercAbi, factoryAbi, HAMMR, hammrPc, livePrice, loadFills, loadLot, routerAbi,
  type Fill, type Lot as LotT,
} from "./client";
import { Countdown, fmtEth, fmtTok, Gavel, LivePriceEth, short, useTick } from "./ui";
import { pairUsd, resolvePairRoute } from "../lib/rh/routes";
import { useWallet } from "../lib/useWallet";
import { useUi } from "../store";
import { errorText } from "../lib/useWallet";
import { env } from "../lib/env";

export function LotPage() {
  const { address } = useParams<{ address: string }>();
  const [lot, setLot] = useState<LotT | null>(null);
  const [fills, setFills] = useState<Fill[]>([]);
  const [ethUsd, setEthUsd] = useState(0);

  useEffect(() => {
    if (!address) return;
    let live = true;
    const refresh = () => {
      loadLot(address as Address).then((l) => live && setLot(l)).catch(() => undefined);
      loadFills(address as Address).then((f) => live && setFills(f)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 10_000);
    pairUsd(HAMMR.weth, hammrPc).then((v) => live && setEthUsd(v)).catch(() => undefined);
    return () => { live = false; clearInterval(id); };
  }, [address]);

  if (!lot) {
    return <div className="hm-shell grid h-72 place-items-center" style={{ color: "var(--h-ink-3)" }}>Bringing the lot to the block…</div>;
  }

  const expired = !lot.live && !lot.finalized;
  return (
    <div className="hm-shell hm-rise" style={{ paddingBottom: 90 }}>
      <Link to="/" className="hm-lot-no mt-6 inline-block" style={{ color: "var(--h-ink-3)" }}>← back to the floor</Link>

      <div className="mt-3 grid gap-5 lg:grid-cols-[1.1fr_1fr]">
        {/* Left: identity + fills */}
        <div>
          <div className="flex items-start gap-4">
            <span className="grid h-16 w-16 shrink-0 place-items-center overflow-hidden rounded-2xl border" style={{ borderColor: "var(--h-edge-2)", background: "var(--h-panel)" }}>
              {lot.meta.logo ? <img src={lot.meta.logo} alt="" className="h-full w-full object-cover" /> : <Gavel size={30} />}
            </span>
            <div className="min-w-0">
              {lot.live
                ? <span className="hm-live"><i />Live auction</span>
                : lot.finalized
                  ? <span className="hm-hammered">HAMMERED ⚒ trading open</span>
                  : <span className="hm-chip">auction ended · awaiting the hammer</span>}
              <h1 className="hm-lotname mt-1.5">{lot.name} <span className="hm-price" style={{ fontSize: "0.55em", color: "var(--h-brass-2)" }}>${lot.symbol}</span></h1>
              <p className="mt-1 text-[12px]" style={{ color: "var(--h-ink-3)" }}>
                consigned by {short(lot.creator)} · pairs &amp; earns <b style={{ color: "var(--h-ink-2)" }}>{lot.pairSymbol}</b> · {(lot.taxBps / 100).toFixed(1)}% fee, 80% to holders
              </p>
            </div>
          </div>

          {lot.meta.description && (
            <p className="mt-4 max-w-xl text-[14px] leading-relaxed" style={{ color: "var(--h-ink-2)" }}>{lot.meta.description}</p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {lot.meta.website && <a className="hm-chip" href={lot.meta.website} target="_blank" rel="noreferrer">website</a>}
            {lot.meta.twitter && <a className="hm-chip" href={lot.meta.twitter} target="_blank" rel="noreferrer">x / twitter</a>}
            {env.explorerUrl && <a className="hm-chip" href={`${env.explorerUrl}/token/${lot.address}`} target="_blank" rel="noreferrer">contract ↗</a>}
          </div>

          <p className="hm-lot-no mt-8 mb-2">auction fills</p>
          <div className="hm-rows rounded-2xl border px-4 py-1" style={{ borderColor: "var(--h-edge)", background: "var(--h-panel)" }}>
            {fills.length === 0 ? (
              <p className="py-4 text-center text-[13px]" style={{ color: "var(--h-ink-3)" }}>No fills yet. First buy takes the top of the book.</p>
            ) : fills.map((f) => (
              <div className="r" key={f.txHash + f.buyer}>
                <span style={{ color: "var(--h-ink-2)" }}>{short(f.buyer)}</span>
                <span className="hm-price">{fmtTok(f.tokensOut)} ${lot.symbol}</span>
                <span className="hm-price" style={{ color: "var(--h-brass-2)" }}>{fmtEth(f.ethIn)} ETH</span>
              </div>
            ))}
          </div>
        </div>

        {/* Right: the block */}
        <div>
          {lot.live && <AuctionPanel lot={lot} ethUsd={ethUsd} />}
          {expired && <FinalizePanel lot={lot} />}
          {lot.finalized && <TradePanelLite lot={lot} />}
        </div>
      </div>
    </div>
  );
}

function AuctionPanel({ lot, ethUsd }: { lot: LotT; ethUsd: number }) {
  useTick();
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);

  const p = livePrice(lot);
  const mcapUsd = ethUsd > 0 ? (Number(p) / 1e18) * 1e9 * ethUsd : 0;
  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);
  const tokensOut = p > 0n && parsed > 0n ? (parsed * 10n ** 18n) / p : 0n;
  const capped = tokensOut > lot.remaining ? lot.remaining : tokensOut;
  const soldPct = Math.min(100, (Number(lot.sold) / 1e18 / AUCTION_SUPPLY) * 100);

  const buy = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "buy", args: [lot.address], value: parsed, chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Buy submitted", txHash: hash });
      await hammrPc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Filled at the falling price", txHash: hash });
      setAmt("");
    } catch (e) {
      pushToast({ kind: "error", title: "Buy failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: "var(--h-edge)", background: "var(--h-panel)" }}>
      <div className="flex items-center justify-between">
        <p className="hm-lot-no">price · falling to the floor</p>
        <span className="hm-live"><i /><Countdown endTime={lot.endTime} /></span>
      </div>
      <p className="hm-price hm-price-big mt-2"><LivePriceEth lot={lot} /> <span style={{ fontSize: "0.45em", color: "var(--h-ink-2)" }}>ETH</span></p>
      <p className="hm-price mt-1 text-[12.5px]" style={{ color: "var(--h-ink-2)" }}>
        {mcapUsd > 0 ? `implied mcap ≈ $${(mcapUsd / 1000).toFixed(1)}k · ` : ""}floor {fmtEth(lot.floorPriceWei, 9)} ETH
      </p>

      <div className="hm-track mt-4" style={{ "--pct": `${soldPct}%` } as CSSProperties}><i /></div>
      <div className="mt-1.5 flex justify-between text-[11.5px]" style={{ color: "var(--h-ink-3)" }}>
        <span>{fmtTok(lot.sold)} sold</span><span>{fmtTok(lot.remaining)} remaining</span>
      </div>

      <div className="hm-field mt-5">
        <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="hm-chip shrink-0">ETH</span>
      </div>
      <p className="hm-price mt-2 h-4 text-[12.5px]" style={{ color: "var(--h-ink-2)" }}>
        {capped > 0n ? `≈ ${fmtTok(capped)} $${lot.symbol} at the current price` : ""}
      </p>
      <button className="hm-cta mt-3" disabled={busy || (isConnected && parsed === 0n)} onClick={buy}>
        {busy ? "Confirm in wallet…" : isConnected ? `Buy $${lot.symbol}` : "Connect wallet"}
      </button>
      <p className="mt-3 text-center text-[11.5px]" style={{ color: "var(--h-ink-3)" }}>
        Falling-price auction: everyone who waits pays less, everyone who buys gets filled instantly.
      </p>
    </div>
  );
}

function FinalizePanel({ lot }: { lot: LotT }) {
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [busy, setBusy] = useState(false);

  const finalize = async () => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await wc.writeContract({ address: HAMMR.factory, abi: factoryAbi, functionName: "finalize", args: [lot.address], chain: wc.chain, account: wc.account });
      pushToast({ kind: "info", title: "Dropping the hammer…", txHash: hash });
      await hammrPc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: "Hammered. Trading is open.", txHash: hash });
    } catch (e) {
      pushToast({ kind: "error", title: "Finalize failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border p-6 text-center" style={{ borderColor: "var(--h-edge)", background: "var(--h-panel)" }}>
      <Gavel size={36} />
      <p className="hm-lotname mt-3" style={{ fontSize: 22 }}>Ready for the hammer</p>
      <p className="mx-auto mt-1 max-w-xs text-[13px]" style={{ color: "var(--h-ink-2)" }}>
        The auction has closed with {fmtEth(lot.raisedWei)} ETH raised. Anyone can drop the hammer:
        the raise becomes locked liquidity and trading opens.
      </p>
      <button className="hm-cta mt-4" disabled={busy} onClick={finalize}>
        {busy ? "Hammering…" : "Drop the hammer ⚒"}
      </button>
    </div>
  );
}

/** Post-auction: simple ETH buy/sell through the RhRouter + rewards claim. */
function TradePanelLite({ lot }: { lot: LotT }) {
  const { address: me, isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((s) => s.pushToast);
  const [side, setSide] = useState<"buy" | "sell">("buy");
  const [amt, setAmt] = useState("");
  const [busy, setBusy] = useState(false);
  const [bal, setBal] = useState(0n);
  const [pending, setPending] = useState(0n);

  useEffect(() => {
    if (!me) return;
    let live = true;
    const refresh = () => {
      hammrPc.readContract({ address: lot.address, abi: ercAbi, functionName: "balanceOf", args: [me] }).then((v) => live && setBal(v as bigint)).catch(() => undefined);
      hammrPc.readContract({ address: lot.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).then((v) => live && setPending(v as bigint)).catch(() => undefined);
    };
    refresh();
    const id = setInterval(refresh, 12_000);
    return () => { live = false; clearInterval(id); };
  }, [me, lot.address]);

  const parsed = useMemo(() => { try { return amt ? parseEther(amt) : 0n; } catch { return 0n; } }, [amt]);

  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc || parsed === 0n) return;
    setBusy(true);
    try {
      const route = await resolvePairRoute(hammrPc, lot.pair);
      let hash: `0x${string}`;
      if (side === "buy") {
        hash = await wc.writeContract({ address: HAMMR.router, abi: routerAbi, functionName: "buy", args: [lot.address, route.buy, 0n], value: parsed, chain: wc.chain, account: wc.account });
      } else {
        const allowance = (await hammrPc.readContract({ address: lot.address, abi: ercAbi, functionName: "allowance", args: [wc.account.address, HAMMR.router] })) as bigint;
        if (allowance < parsed) {
          const a = await wc.writeContract({ address: lot.address, abi: ercAbi, functionName: "approve", args: [HAMMR.router, 2n ** 256n - 1n], chain: wc.chain, account: wc.account });
          await hammrPc.waitForTransactionReceipt({ hash: a });
        }
        hash = await wc.writeContract({ address: HAMMR.router, abi: routerAbi, functionName: "sell", args: [lot.address, parsed, route.sell, 0n], chain: wc.chain, account: wc.account });
      }
      pushToast({ kind: "info", title: `${side === "buy" ? "Buy" : "Sell"} submitted`, txHash: hash });
      await hammrPc.waitForTransactionReceipt({ hash });
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
      const hash = await wc.writeContract({ address: lot.address, abi: ercAbi, functionName: "claim", args: [], chain: wc.chain, account: wc.account });
      await hammrPc.waitForTransactionReceipt({ hash });
      pushToast({ kind: "success", title: `${lot.pairSymbol} rewards claimed`, txHash: hash });
      setPending(0n);
    } catch (e) {
      pushToast({ kind: "error", title: "Claim failed", body: errorText(e) });
    } finally { setBusy(false); }
  };

  return (
    <div className="rounded-2xl border p-5" style={{ borderColor: "var(--h-edge)", background: "var(--h-panel)" }}>
      <div className="flex gap-2">
        {(["buy", "sell"] as const).map((s) => (
          <button key={s} onClick={() => { setSide(s); setAmt(""); }}
            className="flex-1 rounded-xl py-2.5 text-[13.5px] font-800"
            style={{
              fontWeight: 800,
              background: side === s ? (s === "buy" ? "linear-gradient(180deg,var(--h-brass-2),var(--h-brass))" : "var(--h-panel-2)") : "transparent",
              color: side === s ? (s === "buy" ? "var(--h-brass-fg)" : "var(--h-ink)") : "var(--h-ink-3)",
              border: side === s ? "none" : `1px solid var(--h-edge)`,
            }}>
            {s === "buy" ? "Buy" : "Sell"}
          </button>
        ))}
      </div>

      <div className="hm-field mt-4">
        <input inputMode="decimal" placeholder="0.0" value={amt} onChange={(e) => setAmt(e.target.value.replace(/[^0-9.]/g, ""))} />
        <span className="hm-chip shrink-0">{side === "buy" ? "ETH" : `$${lot.symbol}`}</span>
      </div>
      {side === "sell" && bal > 0n && (
        <p className="mt-1.5 text-[11.5px]" style={{ color: "var(--h-ink-3)" }}>
          balance {fmtTok(bal)} · <button style={{ color: "var(--h-brass-2)" }} onClick={() => setAmt(String(Number(bal) / 1e18))}>max</button>
        </p>
      )}
      <button className="hm-cta mt-3" disabled={busy || (isConnected && parsed === 0n)} onClick={go}>
        {busy ? "Confirm in wallet…" : isConnected ? (side === "buy" ? `Buy $${lot.symbol}` : `Sell $${lot.symbol}`) : "Connect wallet"}
      </button>

      {isConnected && pending > 0n && (
        <div className="mt-4 flex items-center justify-between rounded-xl border px-4 py-3" style={{ borderColor: "#f0b42955", background: "#f0b4290d" }}>
          <div>
            <p className="text-[11px] font-bold uppercase tracking-wide" style={{ color: "var(--h-ink-3)" }}>your rewards</p>
            <p className="hm-price text-[15px]" style={{ color: "var(--h-brass-2)" }}>{fmtEth(pending, 6)} {lot.pairSymbol}</p>
          </div>
          <button className="hm-cta" style={{ width: "auto", padding: "9px 18px", fontSize: 13 }} disabled={busy} onClick={claim}>Claim</button>
        </div>
      )}
      <p className="mt-3 text-center text-[11.5px]" style={{ color: "var(--h-ink-3)" }}>
        Every trade pays holders 80% of the fee in {lot.pairSymbol}. Delivered automatically.
      </p>
    </div>
  );
}
