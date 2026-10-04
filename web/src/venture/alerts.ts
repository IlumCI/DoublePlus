import { useEffect, useState } from "react";

import type { Phase, Venture } from "./client";

/**
 * Opt-in alerts for coins a viewer chose to watch: nearly full, graduated,
 * refunds open. The point is to let people stop staring at a chart; nothing
 * fires for a coin nobody asked about. Delivered as an in-app toast and, when
 * the browser allows it, a system notification. They work while a doubleplus
 * tab is open; there is no push server.
 */

const KEY = "dp-watch";

// Local, so this module stays free of the chain client and testable.
const pct = (a: bigint, b: bigint): number => (b === 0n ? 0 : Math.min(100, Number((a * 10_000n) / b) / 100));
const NEARLY_FULL = 90;

interface Snapshot { phase: Phase; funded: number }
export interface Alert { token: string; symbol: string; title: string; body: string }

/** What changed for one coin between two polls, as alerts. Pure. */
export function alertsFor(prev: Snapshot | undefined, v: Venture): Alert[] {
  if (!prev) return []; // first sighting: nothing has changed yet
  const funded = v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei);
  const out: Alert[] = [];
  const base = { token: v.address, symbol: v.symbol };
  if (prev.phase !== "graduated" && v.phase === "graduated") {
    out.push({ ...base, title: `$${v.symbol} graduated`, body: "It's trading on Uniswap now." });
  } else if (prev.phase !== "failed" && v.phase === "failed") {
    out.push({ ...base, title: `$${v.symbol} missed its target`, body: "Refunds are open: get your ETH back from your portfolio." });
  } else if (v.phase === "raising" && prev.funded < NEARLY_FULL && funded >= NEARLY_FULL) {
    out.push({ ...base, title: `$${v.symbol} is ${funded.toFixed(0)}% full`, body: "Close to graduating." });
  }
  return out;
}

function snapshot(v: Venture): Snapshot {
  return { phase: v.phase, funded: v.phase === "graduated" ? 100 : pct(v.raisedWei, v.targetRaiseWei) };
}

function readWatched(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(KEY) ?? "[]") as string[]); } catch { return new Set(); }
}
let watched = readWatched();
const subs = new Set<() => void>();

function isWatched(token: string): boolean { return watched.has(token.toLowerCase()); }

async function setWatched(token: string, on: boolean): Promise<void> {
  const k = token.toLowerCase();
  if (on) watched.add(k); else watched.delete(k);
  try { localStorage.setItem(KEY, JSON.stringify([...watched])); } catch { /* private mode: this tab only */ }
  subs.forEach((f) => f());
  // Ask for system notifications only at the moment someone turns an alert on.
  if (on && typeof Notification !== "undefined" && Notification.permission === "default") {
    await Notification.requestPermission().catch(() => undefined);
  }
}

export function useWatched(token: string): [boolean, (on: boolean) => void] {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    subs.add(f);
    return () => { subs.delete(f); };
  }, []);
  return [isWatched(token), (on) => { void setWatched(token, on); }];
}

const last = new Map<string, Snapshot>();

/** Run once per poll with the fresh board; returns the alerts to deliver. */
export function diffWatched(ventures: Venture[]): Alert[] {
  const out: Alert[] = [];
  for (const v of ventures) {
    const k = v.address.toLowerCase();
    if (watched.has(k)) out.push(...alertsFor(last.get(k), v));
    last.set(k, snapshot(v));
  }
  return out;
}

export function notify(a: Alert, onClick: () => void): void {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    const n = new Notification(a.title, { body: a.body, tag: `${a.token}:${a.title}`, icon: "/favicon.png" });
    n.onclick = () => { window.focus(); onClick(); n.close(); };
  } catch { /* some mobile browsers only notify through a service worker */ }
}
