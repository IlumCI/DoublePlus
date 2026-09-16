import { useEffect, useState } from "react";
import { Link } from "react-router-dom";

import { loadVentures, type Venture } from "./client";
import { Countdown, Flag, fmtEth, pct, short } from "./ui";

export function Board() {
  const [ventures, setVentures] = useState<Venture[] | null>(null);

  useEffect(() => {
    let live = true;
    const refresh = () => loadVentures().then((v) => live && setVentures(v)).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const raising = (ventures ?? []).filter((v) => v.phase === "raising" || v.phase === "expired");
  const graduated = (ventures ?? []).filter((v) => v.phase === "graduated");
  const failed = (ventures ?? []).filter((v) => v.phase === "failed");

  return (
    <div className="vn-shell vn-rise" style={{ paddingBottom: 90 }}>
      <div className="mt-10 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="vn-eyebrow">open raises</p>
          <h1 className="vn-title mt-1">Back the next one early.</h1>
          <p className="mt-2 max-w-lg text-[14px]" style={{ color: "var(--v-ink-2)" }}>
            Every venture here published its full term sheet on-chain: target, founder cut, vested stake, deadline.
            Fund it on the curve; if the round fails, you get every wei back.
          </p>
        </div>
        <Link to="/launch" className="vn-cta" style={{ width: "auto", padding: "12px 22px" }}>Found a startup →</Link>
      </div>

      {ventures === null ? (
        <div className="grid h-60 place-items-center" style={{ color: "var(--v-ink-3)" }}>Reading the order book…</div>
      ) : ventures.length === 0 ? (
        <div className="vn-card mt-8 grid place-items-center p-14 text-center">
          <Flag size={36} />
          <p className="vn-title mt-3" style={{ fontSize: 22 }}>No raises yet.</p>
          <p className="mt-1 text-[13.5px]" style={{ color: "var(--v-ink-2)" }}>Yours could be the first on the board.</p>
          <Link to="/launch" className="vn-cta mt-5" style={{ width: "auto", padding: "11px 20px" }}>Open a raise</Link>
        </div>
      ) : (
        <>
          <Section title="raising now" items={raising} />
          <Section title="graduated · trading live" items={graduated} />
          <Section title="closed without funding" items={failed} />
        </>
      )}
    </div>
  );
}

function Section({ title, items }: { title: string; items: Venture[] }) {
  if (items.length === 0) return null;
  return (
    <>
      <p className="vn-eyebrow mt-10 mb-3">{title}</p>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {items.map((v) => <Card key={v.address} v={v} />)}
      </div>
    </>
  );
}

function Card({ v }: { v: Venture }) {
  const funded = pct(v.raisedWei, v.targetRaiseWei);
  return (
    <Link to={`/venture/${v.address}`} className="vn-card vn-card-link p-5">
      <div className="flex items-start gap-3">
        <span className="grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-xl border" style={{ borderColor: "var(--v-edge-2)", background: "var(--v-panel-2)" }}>
          {v.meta.logo ? <img src={v.meta.logo} alt="" className="h-full w-full object-cover" /> : <Flag size={22} />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center justify-between gap-2">
            <p className="truncate font-extrabold" style={{ letterSpacing: "-0.01em" }}>{v.name}</p>
            <Badge v={v} />
          </div>
          <p className="text-[12px]" style={{ color: "var(--v-ink-3)" }}>${v.symbol} · by {short(v.creator)}</p>
        </div>
      </div>

      {(v.meta.pitch || v.meta.description) && (
        <p className="mt-3 line-clamp-2 text-[12.5px] leading-relaxed" style={{ color: "var(--v-ink-2)" }}>
          {v.meta.pitch || v.meta.description}
        </p>
      )}

      <div className="vn-track mt-4" style={{ ["--pct" as string]: `${funded}%` }}><i /></div>
      <div className="mt-1.5 flex items-center justify-between text-[11.5px]" style={{ color: "var(--v-ink-3)" }}>
        <span className="vn-num">{fmtEth(v.raisedWei, 4)} / {fmtEth(v.targetRaiseWei, 4)} ETH</span>
        {v.phase === "raising" ? <Countdown deadline={v.deadline} /> : <span>{funded.toFixed(0)}% funded</span>}
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5 text-[10.5px]">
        <span className="vn-chip" style={{ padding: "2px 8px" }}>founder {v.founderRaiseBps / 100}% of raise</span>
        <span className="vn-chip" style={{ padding: "2px 8px" }}>{(v.taxBps / 100).toFixed(1)}% fee → dividends</span>
      </div>
    </Link>
  );
}

function Badge({ v }: { v: Venture }) {
  if (v.phase === "graduated") return <span className="vn-badge graduated">Trading</span>;
  if (v.phase === "failed") return <span className="vn-badge failed">Refunds open</span>;
  if (v.phase === "expired") return <span className="vn-badge funded">Doubleplusgood ✓</span>;
  return <span className="vn-badge raising"><i />Raising</span>;
}
