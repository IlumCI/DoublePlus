import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { Address, TokenSummary } from "@launchpad/sdk";

import { TokenLogo } from "./TokenLogo";
import { client, v4Client } from "../lib/client";
import { env } from "../lib/env";
import { fmtUsd, fmtWei } from "../lib/format";
import { isHidden } from "../lib/hiddenTokens";

const hookAbi = [
  { type: "function", name: "genesis", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "currentEpoch", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "communityPot", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "traderPot", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "topTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address[3]" }] },
  { type: "function", name: "tokenVol", stateMutability: "view", inputs: [{ type: "uint256" }, { type: "address" }], outputs: [{ type: "uint256" }] },
] as const;

const EPOCH_S = 7 * 24 * 3600;
const SHARES = [50, 30, 20];

interface State {
  epoch: bigint;
  genesis: number;
  pot: bigint;
  traderPot: bigint;
  top: { address: string; vol: bigint }[];
}

/** The week's flywheel, front and center: burn pot, countdown, and the live
 *  top-3 leaderboard whose coins get bought back and burned when the week
 *  closes. Every number is straight from the hook. */
export function FlywheelPanel({ tokens, ethUsd }: { tokens: TokenSummary[]; ethUsd: number }) {
  const [s, setS] = useState<State | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let live = true;
    const hook = (v4Client as any).v4.hook as Address;
    const load = async () => {
      try {
        const [genesis, epoch, pot] = await Promise.all([
          client.publicClient.readContract({ address: hook, abi: hookAbi, functionName: "genesis" }),
          client.publicClient.readContract({ address: hook, abi: hookAbi, functionName: "currentEpoch" }),
          client.publicClient.readContract({ address: hook, abi: hookAbi, functionName: "communityPot" }),
        ]);
        const [tp, top] = await Promise.all([
          client.publicClient.readContract({ address: hook, abi: hookAbi, functionName: "traderPot", args: [epoch as bigint] }),
          client.publicClient.readContract({ address: hook, abi: hookAbi, functionName: "topTokens", args: [epoch as bigint] }),
        ]);
        const addrs = (top as readonly string[]).filter((a) => !/^0x0+$/.test(a));
        const vols = await Promise.all(
          addrs.map(
            (a) =>
              client.publicClient.readContract({
                address: hook,
                abi: hookAbi,
                functionName: "tokenVol",
                args: [epoch as bigint, a as Address],
              }) as Promise<bigint>,
          ),
        );
        if (!live) return;
        setS({
          epoch: epoch as bigint,
          genesis: Number(genesis),
          pot: pot as bigint,
          traderPot: tp as bigint,
          top: addrs.map((address, i) => ({ address, vol: vols[i] })),
        });
      } catch {
        /* pre-flywheel deployment or transient RPC */
      }
    };
    load();
    const id = setInterval(() => {
      if (!document.hidden) load();
    }, 20_000);
    return () => {
      live = false;
      clearInterval(id);
    };
  }, []);

  const byAddr = useMemo(() => {
    const m = new Map<string, TokenSummary>();
    for (const t of tokens) m.set(t.address.toLowerCase(), t);
    return m;
  }, [tokens]);

  if (!s) return null;

  // Pre-launch quiet mode: with every token hidden the counter renders at
  // zero (empty podium, empty pots) so the site reads fresh until launch.
  const quiet = env.hideTokens;
  const pot = quiet ? 0n : s.pot;
  const tPot = quiet ? 0n : s.traderPot;
  const top = quiet ? [] : s.top.filter((r) => !isHidden(r.address));
  const closeAt = (s.genesis + (Number(s.epoch) + 1) * EPOCH_S) * 1000;
  const left = Math.max(0, closeAt - now);
  const d = Math.floor(left / 86_400_000);
  const h = Math.floor((left % 86_400_000) / 3_600_000);
  const m = Math.floor((left % 3_600_000) / 60_000);
  const sec = Math.floor((left % 60_000) / 1000);
  const countdown = d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${m}m ${sec}s`;
  const potUsd = (Number(pot) / 1e18) * ethUsd;
  const maxVol = top.length ? Number(top[0].vol) : 0;

  return (
    <section className="fly-panel">
      <div className="term-head">
        The burn counter
        <span className="term-head-sub">Week {String(s.epoch)}</span>
      </div>
      <div className="fly-body">
      <div className="burnbox">
        <div className="burnbox-row">
          <div className="burnbox-fire"><i /><i /><i /><i /><i /><i /></div>
          <div className="burnbox-meta">
            <div className="amt">{fmtWei(pot)} ETH</div>
            <div className="lbl">{potUsd > 0 ? `${fmtUsd(potUsd)} · ` : ""}queued for the burn</div>
          </div>
        </div>
        <div className="burnbox-grate" />
      </div>
      <div className="fly-head">
        <p className="fly-sub">
          Buys back and burns the week's top 3 when the counter hits zero
          {tPot > 0n ? <> · {fmtWei(tPot)} ETH pooled for traders</> : null}
        </p>
        <div className="fly-count">
          <p className="fly-count-num">{countdown}</p>
          <p className="fly-count-label">until the burn</p>
        </div>
      </div>

      {top.length > 0 ? (
        <div className="fly-rows">
          {top.map((row, i) => {
            const t = byAddr.get(row.address.toLowerCase());
            const pct = maxVol > 0 ? Math.max(6, (Number(row.vol) / maxVol) * 100) : 0;
            return (
              <Link key={row.address} to={`/token/${row.address}`} className="fly-row">
                <span className="fly-rank">#{i + 1}</span>
                {t ? <TokenLogo token={t} size={26} /> : <span className="fly-logo-fallback" />}
                <span className="fly-id">
                  <b>${t?.symbol ?? row.address.slice(0, 6)}</b>
                  <i>{fmtWei(row.vol)} ETH volume</i>
                </span>
                <span className="fly-bar">
                  <span className="fly-bar-fill" style={{ width: `${pct}%` }} />
                </span>
                <span className="fly-share">{SHARES[i]}%</span>
              </Link>
            );
          })}
        </div>
      ) : (
        <p className="fly-empty">No volume yet this week. The first coins traded take the podium.</p>
      )}
      </div>
    </section>
  );
}
