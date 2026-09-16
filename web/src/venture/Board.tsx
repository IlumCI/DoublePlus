import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";

import { loadVentures, type Venture } from "./client";
import { Countdown, Flag, fmtEth, pct, short } from "./ui";

type Sort = "new" | "funded" | "raised";

export function Board() {
  const [ventures, setVentures] = useState<Venture[] | null>(null);
  const [sort, setSort] = useState<Sort>("new");
  const [q, setQ] = useState("");

  useEffect(() => {
    let live = true;
    const refresh = () => loadVentures().then((v) => live && setVentures(v)).catch(() => undefined);
    refresh();
    const id = setInterval(refresh, 15_000);
    return () => { live = false; clearInterval(id); };
  }, []);

  const filtered = useMemo(() => {
    let list = ventures ?? [];
    const needle = q.trim().toLowerCase();
    if (needle) {
      list = list.filter((v) =>
        v.name.toLowerCase().includes(needle) || v.symbol.toLowerCase().includes(needle) ||
        (v.meta.pitch ?? "").toLowerCase().includes(needle) || v.address.toLowerCase().includes(needle));
    }
    const by: Record<Sort, (a: Venture, b: Venture) => number> = {
      new: (a, b) => b.createdAt - a.createdAt,
      funded: (a, b) => pct(b.raisedWei, b.targetRaiseWei) - pct(a.raisedWei, a.targetRaiseWei),
      raised: (a, b) => (b.raisedWei > a.raisedWei ? 1 : -1),
    };
    return [...list].sort(by[sort]);
  }, [ventures, q, sort]);

  const raising = filtered.filter((v) => v.phase === "raising" || v.phase === "expired");
  const graduated = filtered.filter((v) => v.phase === "graduated");
  const failed = filtered.filter((v) => v.phase === "failed");

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

      <JackpotCard />

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <div className="vn-field" style={{ padding: "8px 12px", maxWidth: 320, flex: 1 }}>
          <input placeholder="Search ventures…" value={q} onChange={(e) => setQ(e.target.value)} style={{ fontSize: 14 }} />
        </div>
        <div className="vn-seg" style={{ width: 260 }}>
          {([["new", "Newest"], ["funded", "% funded"], ["raised", "Raised"]] as const).map(([k, label]) => (
            <button key={k} className={sort === k ? "on" : ""} onClick={() => setSort(k)}>{label}</button>
          ))}
        </div>
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

interface EpochManifest {
  epoch: number;
  totalVolumeEth: string;
  budgetEth: string;
  ventures: { coin: string; volumeEth: string; burnedTokens: string }[];
  rebates: { trader: string; amountEth: string }[];
  dryRun: boolean;
}

/** Latest weekly flywheel epoch, straight from the keeper-published manifest. */
function JackpotCard() {
  const [m, setM] = useState<EpochManifest | null>(null);
  useEffect(() => {
    fetch("/rewards/venture/index.json")
      .then((r) => (r.ok ? r.json() : null))
      .then((idx) => (idx?.epoch ? fetch(`/rewards/venture/epoch-${idx.epoch}.json`) : null))
      .then((r) => (r && r.ok ? r.json() : null))
      .then((mm) => mm && setM(mm))
      .catch(() => undefined);
  }, []);
  if (!m) return null;
  return (
    <div className="vn-card mt-6 flex flex-wrap items-center gap-5 p-5" style={{ borderColor: "#ffc85742" }}>
      <div>
        <p className="vn-eyebrow" style={{ color: "var(--v-amber)" }}>weekly flywheel · epoch {m.epoch}{m.dryRun ? " (dry run)" : ""}</p>
        <p className="mt-1 text-[13px]" style={{ color: "var(--v-ink-2)" }}>
          {m.totalVolumeEth} ETH routed · {m.budgetEth} ETH jackpot — top-3 ventures bought back &amp; burned,
          top traders rebated, outside makers rewarded. Trade or make markets, win either way.
        </p>
      </div>
      <div className="flex-1" />
      <a className="vn-chip" href={`/rewards/venture/epoch-${m.epoch}.json`} target="_blank" rel="noreferrer">manifest ↗</a>
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
        <span className="vn-chip" style={{ padding: "2px 8px" }}>{(v.policy.buyTaxBps / 100).toFixed(1)}%/{(v.policy.sellTaxBps / 100).toFixed(1)}% buy/sell tax</span>
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
