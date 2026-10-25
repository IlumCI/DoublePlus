import { useEffect, useMemo, useState } from "react";
import { zeroAddress } from "viem";
import { useWalletClient } from "wagmi";

import { boostsAbi, confirmTx, deskAbi, factoryAbi, hookAbi, modulesAbi, SOCIAL_FIELDS, VENTURE, venturePc, type Modules, type PoolTrade, type Venture as VentureT, sendTx } from "../client";
import { marketStats } from "../marketStats";
import { profileLinks, type DexProfile } from "../../lib/dexscreener";
import { loadHolding, type Holding } from "../portfolio";
import { safeLinkUrl } from "../safe";
import { useWatched } from "../alerts";
import { BuySellStrength, Delta, fmtEth, fmtUsdPrice, fmtUsdV, StatCell, useTick } from "../ui";
import { errorText, useWallet } from "../../lib/useWallet";
import { useUi } from "../../store";
import { chainNowSecs } from "../clock";
import { chain } from "../../lib/env";
import { BRAND } from "../../lib/brand";


/** Pre-graduation: the curve itself is the chart. */
/** The project's own channels. A trader checks these before anything else,
 *  so they sit with the name rather than buried in a tab. */
export function Socials({ meta, dex }: { meta: VentureT["meta"]; dex?: DexProfile }) {
  const onChain: { label: string; url: string }[] = SOCIAL_FIELDS
    .map(([key, label]) => ({ label: label as string, url: meta[key] ?? "" }))
    .map((l) => ({ ...l, url: safeLinkUrl(l.url) })).filter((l) => l.url);
  // A paid DEX Screener profile often carries a channel the founder never put
  // in the on-chain metadata. Show it, but never shadow the on-chain value:
  // that one the contract vouches for, this one a third party holds.
  const have = new Set(onChain.map((l) => l.url.toLowerCase().replace(/\/+$/, "")));
  const extra = profileLinks(dex?.info ?? null).filter((l) => !have.has(l.url.toLowerCase().replace(/\/+$/, "")));
  const links = [...onChain, ...extra];
  if (links.length === 0) return null;
  return (
    <div className="dp-socials">
      {links.map(({ label, url }, i) => (
        <a key={`${label}-${i}`} href={url} target="_blank" rel="noreferrer noopener">{label} ↗</a>
      ))}
    </div>
  );
}

/** Price, size and momentum, read straight off the swap log. */
export function StatBar({ v, trades, ethUsd }: { v: VentureT; trades: PoolTrade[]; ethUsd: number }) {
  const st = useMemo(() => marketStats(trades, chainNowSecs()), [trades]);
  const priceEth = Number(st.priceWei) / 1e18;
  return (
    <>
      <div className="dp-statbar">
        <StatCell k="price">{ethUsd > 0 && priceEth > 0 ? fmtUsdPrice(priceEth * ethUsd) : `${fmtEth(st.priceWei, 8)}`}</StatCell>
        <StatCell k="24h vol">{ethUsd > 0 ? fmtUsdV((Number(st.vol24Wei) / 1e18) * ethUsd) : `${fmtEth(st.vol24Wei, 3)} ETH`}</StatCell>
        <StatCell k="24h txns">{st.buys24 + st.sells24}</StatCell>
        <StatCell k="5m"><Delta pct={st.change.m5} sinceInception={st.ageSecs < 300} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="1h"><Delta pct={st.change.h1} sinceInception={st.ageSecs < 3_600} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="4h"><Delta pct={st.change.h4} sinceInception={st.ageSecs < 14_400} ageSecs={st.ageSecs} /></StatCell>
        <StatCell k="24h"><Delta pct={st.change.h24} sinceInception={st.ageSecs < 86_400} ageSecs={st.ageSecs} /></StatCell>
        <PotCell v={v} priceWei={st.priceWei} ethUsd={ethUsd} tradeCount={trades.length} />
        <JackpotCell v={v} priceWei={st.priceWei} ethUsd={ethUsd} tradeCount={trades.length} />
        <BuybackCell v={v} ethUsd={ethUsd} tradeCount={trades.length} />
      </div>
      {st.buys24 + st.sells24 > 0 && (
        <div style={{ margin: "-4px 0 14px" }}>
          <BuySellStrength buyWei={st.buyVol24Wei} sellWei={st.sellVol24Wei} buys={st.buys24} sells={st.sells24} />
        </div>
      )}
    </>
  );
}

type Pot = { pairAmount: bigint; coinAmount: bigint; leader: `0x${string}`; deadline: bigint };

/** On a system with a curve desk, a coin's pot, jackpot and buyback run from
 *  its first curve trade, held by the desk until it graduates. */
const onDesk = (v: VentureT) => v.sys.desk !== zeroAddress && !v.finalized;

/** The pot, jackpot and buyback of a coin still on its curve. */
export function CurveStatBar({ v, ethUsd, tradeCount }: { v: VentureT; ethUsd: number; tradeCount: number }) {
  if (v.sys.desk === zeroAddress) return null;
  return (
    <div className="dp-statbar">
      <PotCell v={v} priceWei={v.priceWei} ethUsd={ethUsd} tradeCount={tradeCount} />
      <JackpotCell v={v} priceWei={v.priceWei} ethUsd={ethUsd} tradeCount={tradeCount} />
      <BuybackCell v={v} ethUsd={ethUsd} tradeCount={tradeCount} />
    </div>
  );
}

/** ETH loaded into a coin's buyback, which buys the coin and burns it. */
function BuybackCell({ v, ethUsd, tradeCount }: { v: VentureT; ethUsd: number; tradeCount: number }) {
  const [wei, setWei] = useState<bigint | null>(null);
  useEffect(() => {
    if (v.sys.desk === zeroAddress) return;
    let live = true;
    venturePc.readContract({ address: v.sys.desk, abi: deskAbi, functionName: "buybackOf", args: [v.address] })
      .then((x) => { if (live) setWei(x); })
      .catch(() => {});
    return () => { live = false; };
  }, [v.sys.desk, v.address, tradeCount]);
  if (!wei) return null;
  return <StatCell k="buyback loaded">{ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 4)} ETH`}</StatCell>;
}

/** The last-buyer pot: its value and the leader's clock. Re-read on every
 *  new trade, since any trade can move the pot, the lead or pay it out. */
function PotCell({ v, priceWei, ethUsd, tradeCount }: { v: VentureT; priceWei: bigint; ethUsd: number; tradeCount: number }) {
  const { address: me } = useWallet();
  const [pot, setPot] = useState<Pot | null>(null);
  const desk = onDesk(v);
  useEffect(() => {
    let live = true;
    const read = () => (desk
      ? venturePc.readContract({ address: v.sys.desk, abi: deskAbi, functionName: "potOf", args: [v.address] })
        .then(([eth, deadline, leader]) => ({ pairAmount: eth, coinAmount: 0n, leader, deadline }))
      : venturePc.readContract({ address: v.sys.hook, abi: hookAbi, functionName: "pot", args: [v.address] })
        .then(([pairAmount, coinAmount, leader, deadline]) => ({ pairAmount, coinAmount, leader, deadline })))
      .then((p) => { if (live) setPot(p); })
      .catch(() => {});
    read();
    const id = setInterval(read, 30_000);
    return () => { live = false; clearInterval(id); };
  }, [v.address, v.sys, desk, tradeCount]);
  useTick();
  if (!pot) return null;
  const wei = pot.pairAmount + (pot.coinAmount * priceWei) / 10n ** 18n;
  const value = ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 4)} ETH`;
  const leading = pot.leader !== zeroAddress;
  const left = Math.max(0, Number(pot.deadline) - chainNowSecs());
  const clock = `${left >= 3600 ? `${Math.floor(left / 3600)}:` : ""}${String(Math.floor((left % 3600) / 60)).padStart(left >= 3600 ? 2 : 1, "0")}:${String(left % 60).padStart(2, "0")}`;
  const mine = leading && me !== undefined && pot.leader.toLowerCase() === me.toLowerCase();
  return (
    <StatCell k={leading ? `pot · ${clock}${mine ? " · you" : ""}` : "pot"}>
      <span title={leading ? `Last buyer: ${pot.leader}` : undefined}>{value}</span>
    </StatCell>
  );
}

/** Every-Nth-buy jackpot: what it holds and how many buys until it pays. */
function JackpotCell({ v, priceWei, ethUsd, tradeCount }: { v: VentureT; priceWei: bigint; ethUsd: number; tradeCount: number }) {
  const mods = useModules(v);
  const [jp, setJp] = useState<{ pair: bigint; coin: bigint; buys: bigint } | null>(null);
  const desk = onDesk(v);
  useEffect(() => {
    if (!mods?.jackpotEvery) return;
    let live = true;
    (desk
      ? venturePc.readContract({ address: v.sys.desk, abi: deskAbi, functionName: "jackpotOf", args: [v.address] })
        .then(([eth, buys]) => ({ pair: eth, coin: 0n, buys }))
      : venturePc.readContract({ address: v.sys.hook, abi: modulesAbi, functionName: "jackpotOf", args: [v.poolId] })
        .then(([pair, c, buys]) => ({ pair, coin: c, buys })))
      .then((j) => { if (live) setJp(j); })
      .catch(() => {});
    return () => { live = false; };
  }, [v.address, v.poolId, v.sys, desk, mods?.jackpotEvery, tradeCount]);
  if (!mods?.jackpotEvery || !jp) return null;
  const wei = jp.pair + (jp.coin * priceWei) / 10n ** 18n;
  const every = BigInt(mods.jackpotEvery);
  const left = every - (jp.buys % every);
  return (
    <StatCell k={`jackpot · ${left} to go`}>
      {ethUsd > 0 ? fmtUsdV((Number(wei) / 1e18) * ethUsd) : `${fmtEth(wei, 4)} ETH`}
    </StatCell>
  );
}

/** A coin's hook modules (read once; they're fixed after launch). */
export function useModules(v: VentureT): Modules | null {
  const [m, setM] = useState<Modules | null>(null);
  const coin = v.address;
  const hook = v.sys.hook;
  useEffect(() => {
    let live = true;
    venturePc.readContract({ address: hook, abi: modulesAbi, functionName: "modulesOf", args: [coin] })
      .then(([burnBps, surgeBps, jackpotBps, jackpotEvery, noFlip, set]) => { if (live) setM({ burnBps, surgeBps, jackpotBps, jackpotEvery, noFlip, set }); })
      .catch(() => {});
    return () => { live = false; };
  }, [coin, hook]);
  return m;
}

/** Buy board placement for a coin, or show how long its boost has left. */
export function BoostButton({ v }: { v: VentureT }) {
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((st) => st.pushToast);
  const [open, setOpen] = useState(false);
  const [hours, setHours] = useState(6);
  const [price, setPrice] = useState<bigint | null>(null);
  const [until, setUntil] = useState(0);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (v.sys.boosts === zeroAddress) return;
    let live = true;
    Promise.all([
      venturePc.readContract({ address: v.sys.boosts, abi: boostsAbi, functionName: "pricePerHour" }),
      venturePc.readContract({ address: v.sys.boosts, abi: boostsAbi, functionName: "activeBoost", args: [v.address] }),
    ]).then(([p, [u]]) => { if (live) { setPrice(p); setUntil(Number(u)); } }).catch(() => undefined);
    return () => { live = false; };
  }, [v.address, busy]);
  useTick();
  if (v.sys.boosts === zeroAddress || price === null || v.phase === "failed") return null;
  const left = until - chainNowSecs();
  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    setBusy(true);
    try {
      const hash = await sendTx(wc, { address: v.sys.boosts, abi: boostsAbi, functionName: "boost", args: [v.address, BigInt(hours)], value: price * BigInt(hours), chain: wc.chain, account: wc.account });
      await confirmTx(hash);
      pushToast({ kind: "success", title: `$${v.symbol} boosted for ${hours}h`, txHash: hash });
      setOpen(false);
    } catch (e) {
      pushToast({ kind: "error", title: "Boost failed", body: errorText(e) });
    } finally { setBusy(false); }
  };
  return (
    <span className="dp-boostctl">
      {left > 0 && <span className="lh-boost">boosted · {left >= 3600 ? `${Math.floor(left / 3600)}h` : `${Math.ceil(left / 60)}m`} left</span>}
      {open ? (
        <>
          <select value={hours} onChange={(e) => setHours(Number(e.target.value))} disabled={busy}>
            {[1, 6, 24, 72].map((h) => <option key={h} value={h}>{h}h · {fmtEth(price * BigInt(h), 4)} ETH</option>)}
          </select>
          <button className="dp-bell" disabled={busy} onClick={go}>{busy ? "Confirm…" : "Boost"}</button>
        </>
      ) : (
        <button className="dp-bell" onClick={() => setOpen(true)}>{left > 0 ? "Extend" : "Boost"}</button>
      )}
    </span>
  );
}

/** The coin's logo as a public URL a wallet can fetch: an inline (data URI)
 *  logo is served by the site Worker at /og/<address>.<ext>. */
function walletLogo(v: VentureT): string | undefined {
  const logo = v.meta.logo ?? "";
  const m = /^data:image\/(png|jpe?g|webp|gif);base64,/i.exec(logo);
  if (m) return `${BRAND.url}/og/${v.address}.${m[1].toLowerCase().replace("jpeg", "jpg")}`;
  return /^https:\/\/[^\s"'<>]+$/i.test(logo) ? logo : undefined;
}

/** Put the coin in the connected wallet's token list (EIP-747). */
export function AddToWallet({ v }: { v: VentureT }) {
  const { isConnected, connectFirst } = useWallet();
  const { data: wc } = useWalletClient();
  const pushToast = useUi((st) => st.pushToast);
  if (v.phase === "failed") return null;
  const go = async () => {
    if (!isConnected) return connectFirst();
    if (!wc) return;
    try {
      if ((await wc.getChainId()) !== chain.id) await wc.switchChain({ id: chain.id });
      const added = await wc.watchAsset({
        type: "ERC20",
        // MetaMask refuses symbols over 11 characters.
        options: { address: v.address, symbol: v.symbol.slice(0, 11), decimals: 18, image: walletLogo(v) },
      });
      if (added) pushToast({ kind: "success", title: `$${v.symbol} added to your wallet` });
    } catch (e) {
      pushToast({ kind: "error", title: "Couldn't add to wallet", body: errorText(e) });
    }
  };
  return <button className="dp-bell" onClick={go}>Add to wallet</button>;
}

/** Watch a coin: an alert when it is nearly full, graduates, or opens
 *  refunds, so nobody has to sit on the chart. Off until someone asks. */
export function AlertToggle({ v }: { v: VentureT }) {
  const [on, set] = useWatched(v.address);
  if (v.phase === "graduated" || v.phase === "failed") return null; // nothing left to wait for
  return (
    <button className={`dp-bell${on ? " on" : ""}`} onClick={() => set(!on)}
      title={on ? "Alerts on: nearly full, graduated, refunds open. Click to stop." : "Get an alert when it's nearly full, graduates, or opens refunds"}>
      {on ? "Alerts on" : "Alert me"}
    </button>
  );
}

/** One line under the market cap: what this wallet's bag is worth if it
 *  cashed out now, and how that compares with what it put in. Nothing when
 *  the wallet has no stake, so nobody reads a row of dashes. */
export function YourBag({ v }: { v: VentureT }) {
  const { address: me } = useWallet();
  const [h, setH] = useState<Holding | null>(null);
  useEffect(() => {
    if (!me) { setH(null); return; }
    let live = true;
    const read = () => {
      venturePc.readContract({ address: v.sys.factory, abi: factoryAbi, functionName: "curveSellFeeBps" })
        .then((bps) => loadHolding(me, v, Number(bps)))
        .then((x) => { if (live) setH(x); })
        .catch(() => undefined);
    };
    read();
    const id = setInterval(() => { if (!document.hidden) read(); }, 20_000);
    return () => { live = false; clearInterval(id); };
  }, [me, v]);
  if (!h || h.pos.valueNow === null || (h.pos.valueNow === 0n && h.pos.putIn === 0n)) return null;
  const { pnl, pnlPct, valueNow, basis } = h.pos;
  const what = basis === "refund" ? "refund due" : "your bag if sold now";
  return (
    <span className="dp-bag" title={basis === "market" ? "At the pool price, less sell fees. Large bags get less due to price impact." : undefined}>
      <span className="dp-k">{what}</span>{" "}
      <b>{fmtEth(valueNow, 4)} ETH</b>
      {pnl !== null && pnlPct !== null && basis !== "refund" && (
        <span className={pnl >= 0n ? "dp-up" : "dp-down"}> {pnl >= 0n ? "+" : ""}{pnlPct.toFixed(Math.abs(pnlPct) < 10 ? 1 : 0)}%</span>
      )}
    </span>
  );
}
