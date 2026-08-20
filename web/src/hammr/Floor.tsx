import { useEffect, useState, type CSSProperties } from "react";
import { Link } from "react-router-dom";

import { loadLots, livePrice, AUCTION_SUPPLY, type Lot } from "./client";
import { Countdown, fmtEth, fmtTok, Gavel, LivePriceEth, useTick } from "./ui";
import { pairUsd } from "../lib/rh/routes";
import { hammrPc, HAMMR } from "./client";

/** The auction floor: the freshest live lot as the hero, the rest in a grid. */
export function Floor() {
  const [lots, setLots] = useState<Lot[] | null>(null);
  const [ethUsd, setEthUsd] = useState(0);

  useEffect(() => {
    let live = true;
    const refresh = () => loadLots().then((l) => live && setLots(l)).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 12_000);
    pairUsd(HAMMR.weth, hammrPc).then((v) => live && setEthUsd(v)).catch(() => undefined);
    return () => { live = false; clearInterval(id); };
  }, []);

  const liveLots = (lots ?? []).filter((l) => l.live);
  const done = (lots ?? []).filter((l) => !l.live);
  const hero = liveLots[0];
  const rest = [...liveLots.slice(1), ...done];

  return (
    <div className="hm-shell hm-rise" style={{ paddingBottom: 80 }}>
      <div className="mt-8 flex items-end justify-between gap-4">
        <div>
          <p className="hm-lot-no">the auction floor · robinhood chain</p>
          <h1 className="hm-lotname mt-1">Every coin goes under the hammer.</h1>
          <p className="mt-2 max-w-xl text-[14px] leading-relaxed" style={{ color: "var(--h-ink-2)" }}>
            New coins start at 10x and fall for one hour. Buy the moment the price feels right;
            when the hammer drops, the raise seeds locked liquidity and holders earn the pair
            token on every trade after.
          </p>
        </div>
        <Link to="/consign" className="hm-cta-ghost hidden sm:block" style={{ width: "auto", padding: "11px 22px" }}>
          Consign a lot →
        </Link>
      </div>

      {lots === null ? (
        <div className="hm-hero mt-6 grid h-64 place-items-center" style={{ color: "var(--h-ink-3)" }}>
          Opening the floor…
        </div>
      ) : hero ? (
        <HeroLot lot={hero} ethUsd={ethUsd} />
      ) : (
        <div className="hm-hero mt-6 grid place-items-center px-6 py-16 text-center">
          <Gavel size={40} />
          <p className="hm-lotname mt-4" style={{ fontSize: 24 }}>The floor is quiet.</p>
          <p className="mt-1 text-[13.5px]" style={{ color: "var(--h-ink-2)" }}>
            No live auctions right now. Be the one that opens the bidding.
          </p>
          <Link to="/consign" className="hm-cta mt-5" style={{ width: "auto", padding: "12px 26px" }}>
            Consign the first lot
          </Link>
        </div>
      )}

      {rest.length > 0 && (
        <>
          <p className="hm-lot-no mt-10 mb-3">{liveLots.length > 1 ? "more on the floor" : "past lots"}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {rest.map((l, i) => <LotCard key={l.address} lot={l} idx={lots!.length - 1 - i} ethUsd={ethUsd} />)}
          </div>
        </>
      )}
    </div>
  );
}

function soldPct(lot: Lot): number {
  return Math.min(100, (Number(lot.sold) / 1e18 / AUCTION_SUPPLY) * 100);
}

function HeroLot({ lot, ethUsd }: { lot: Lot; ethUsd: number }) {
  useTick();
  const p = livePrice(lot);
  const mcapUsd = ethUsd > 0 ? (Number(p) / 1e18) * 1e9 * ethUsd : 0;
  return (
    <Link to={`/lot/${lot.address}`} className="hm-hero mt-6 block">
      <div className="grid gap-0 md:grid-cols-[1.15fr_1fr]">
        <div className="p-7 md:p-9">
          <span className="hm-live"><i />Live · lot closes in <Countdown endTime={lot.endTime} /></span>
          <h2 className="hm-lotname mt-3">{lot.name} <span style={{ color: "var(--h-ink-3)" }}>·</span> <span className="hm-price" style={{ fontSize: "0.6em", color: "var(--h-brass-2)" }}>${lot.symbol}</span></h2>
          <p className="mt-2 line-clamp-2 text-[13.5px] leading-relaxed" style={{ color: "var(--h-ink-2)" }}>
            {lot.meta.description || `Pairs with ${lot.pairSymbol}. Holders earn ${lot.pairSymbol} on every trade after the hammer.`}
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <span className="hm-chip">pairs · earns {lot.pairSymbol}</span>
            <span className="hm-chip">{(lot.taxBps / 100).toFixed(1)}% trade fee · 80% to holders</span>
          </div>
        </div>
        <div className="border-t p-7 md:border-l md:border-t-0 md:p-9" style={{ borderColor: "var(--h-edge)" }}>
          <p className="hm-lot-no">current price · falling</p>
          <p className="hm-price hm-price-big mt-1"><LivePriceEth lot={lot} /> <span style={{ fontSize: "0.45em", color: "var(--h-ink-2)" }}>ETH</span></p>
          {mcapUsd > 0 && <p className="hm-price mt-1 text-[13px]" style={{ color: "var(--h-ink-2)" }}>implied mcap ≈ {mcapUsd >= 1000 ? `$${(mcapUsd / 1000).toFixed(1)}k` : `$${mcapUsd.toFixed(0)}`}</p>}
          <div className="hm-track mt-5" style={{ "--pct": `${soldPct(lot)}%` } as CSSProperties}><i /></div>
          <div className="mt-2 flex justify-between text-[12px]" style={{ color: "var(--h-ink-3)" }}>
            <span>{fmtTok(lot.sold)} sold</span>
            <span>{fmtTok(lot.remaining)} left of {AUCTION_SUPPLY / 1e6}M</span>
          </div>
          <div className="hm-cta mt-6 text-center">Place a buy →</div>
        </div>
      </div>
    </Link>
  );
}

function LotCard({ lot, idx, ethUsd }: { lot: Lot; idx: number; ethUsd: number }) {
  const p = lot.live ? livePrice(lot) : lot.priceWei;
  const raisedUsd = ethUsd > 0 ? (Number(lot.raisedWei) / 1e18) * ethUsd : 0;
  return (
    <Link to={`/lot/${lot.address}`} className="hm-card">
      <div className="hm-card-art grid place-items-center">
        {lot.meta.logo ? (
          <img src={lot.meta.logo} alt="" loading="lazy" />
        ) : (
          <Gavel size={44} />
        )}
        <span className="absolute left-3 top-3">
          {lot.live
            ? <span className="hm-live" style={{ background: "#0d0b08cc", borderRadius: 999, padding: "4px 10px" }}><i />LIVE</span>
            : <span className="hm-hammered">SOLD ⚒</span>}
        </span>
      </div>
      <div className="p-4">
        <p className="hm-lot-no">lot №{idx + 1}</p>
        <p className="mt-0.5 truncate text-[16px] font-bold" style={{ fontFamily: "var(--h-serif)" }}>
          {lot.name} <span className="hm-price" style={{ fontSize: 12, color: "var(--h-brass-2)" }}>${lot.symbol}</span>
        </p>
        <div className="mt-2.5 flex items-baseline justify-between">
          <span className="hm-price text-[14px]" style={{ color: "var(--h-brass-2)" }}>{fmtEth(p, 8)} ETH</span>
          <span className="text-[11.5px]" style={{ color: "var(--h-ink-3)" }}>
            {lot.live ? <Countdown endTime={lot.endTime} /> : raisedUsd > 0 ? `raised ~$${raisedUsd.toFixed(0)}` : "no raise"}
          </span>
        </div>
        <div className="hm-track mt-2.5" style={{ "--pct": `${soldPct(lot)}%` } as CSSProperties}><i /></div>
      </div>
    </Link>
  );
}
