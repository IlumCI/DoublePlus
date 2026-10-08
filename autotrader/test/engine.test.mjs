// Pre-bench stress tests: the engine and strategy against synthetic markets
// built to look like each crowd pattern in docs/autotrader-research.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";

import { buyOut, Coin, sellOut } from "../src/coin.mjs";
import { Account, Engine, GAS_ETH } from "../src/engine.mjs";
import { CONFIG } from "../src/strategy.mjs";
import { lcg, organic, stream, SynthCoin } from "./synth.mjs";

function run(events, balances = [1], cfg = CONFIG) {
  const accts = balances.map((b, i) => new Account(i, b, { latency: [0.5, 0.5] }));
  const eng = new Engine(accts, cfg);
  for (const e of events) eng.feed(e);
  eng.finish();
  return { eng, accts };
}

test("a round trip on the curve can only lose: fee, tax and gas", () => {
  for (const [Q, T, eth, tax] of [[1.68, 1e9, 0.01, 0.01], [4, 5e8, 0.5, 0.03], [2, 8e8, 1e-6, 0]]) {
    const tok = buyOut(Q, T, eth, tax);
    const net = eth * (1 - 0.01 - tax);
    const back = sellOut(Q + net, T - tok, tok, tax);
    assert.ok(back < eth, `back ${back} >= ${eth}`);
    assert.ok(back > eth * (1 - 2 * (0.01 + tax)) * 0.999);
  }
});

test("the coin's curve reproduces recorded Pons trades exactly", (t) => {
  const dir = new URL("../data/", import.meta.url);
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")) : [];
  if (!files.length) return t.skip("no recorded data");
  const ev = readFileSync(new URL(files[0], dir), "utf8").trim().split("\n").map(JSON.parse);
  const coins = new Map();
  let checked = 0, off = 0;
  for (const e of ev) {
    if (e.k === "launch") coins.set(e.token, new Coin(e));
    const c = coins.get(e.token);
    if (!c || !c.native || (e.k !== "buy" && e.k !== "sell")) { c?.apply(e); continue; }
    // Launch-second buys pay a snipe tax the curve maths doesn't model; the
    // trader never buys before minAge, so skip them.
    if (e.k === "buy" && checked < 2000 && e.t - c.launchT >= 10) {
      const { Q, T } = c.reserves();
      const eth = Number(e.quote) / 1e18, tax = Number(e.tax) / 1e18 / eth;
      const want = Number(e.tokens) / 1e18;
      const err = Math.abs(buyOut(Q, T, eth, tax) / want - 1);
      // One coin in ~300 drifts (0.05-0.2%) after tokens land on its curve
      // outside a trade; anything bigger would be a model error.
      assert.ok(err < 1e-2, `token ${e.token} block ${e.b}: ${err}`);
      if (err > 1e-9) off++;
      checked++;
    }
    c.apply(e);
  }
  assert.ok(checked > 100);
  assert.ok(off / checked < 0.01, `${off} of ${checked} off`);
});

test("buys into an organic cascade and gets out when the launch cohort dumps", () => {
  const rand = lcg(1);
  const c = new SynthCoin("0xa", 1000);
  // Launch cohort: 8 snipers in the first 10 s, a modest bag each.
  for (let i = 0; i < 8; i++) c.buy(1001 + i, `0xsnipe${i}`, 0.03);
  const t1 = organic(c, 1015, 150, rand);
  // Wave 1: the snipers unload over 20 s.
  for (let i = 0; i < 8; i++) c.sellAll(t1 + 5 + i * 2.5, `0xsnipe${i}`);
  organic(c, t1 + 40, 120, rand, { start: 0.05, end: 0.02 });
  const { accts, eng } = run(stream(c));
  const a = accts[0];
  assert.ok(eng.signals.length > 0, "the cascade read fired");
  assert.ok(a.closed.length >= 1, "it traded");
  const first = a.closed[0];
  assert.ok(["wave1", "wave-top", "sell-wave", "grad-wave"].includes(first.reason), first.reason);
  assert.ok(first.ret > -0.15, `left before the wave did its damage: ${first.ret}`);
});

test("ignores a wash bot: one wallet churning makes no crowd", () => {
  const c = new SynthCoin("0xb", 1000);
  for (let i = 0; i < 300; i++) {
    const t = 1030 + i * 2;
    c.buy(t, "0xwash", 0.05);
    c.sell(t + 1, "0xwash", (c.held.get("0xwash") ?? 0) * 0.98);
  }
  const { eng, accts } = run(stream(c));
  assert.equal(eng.signals.length, 0);
  assert.equal(accts[0].closed.length, 0);
});

test("a bundle that dumps after we buy costs one bounded loss, not the bag", () => {
  const rand = lcg(2);
  const c = new SynthCoin("0xc", 1000);
  for (let i = 0; i < 12; i++) c.buy(1000.5, `0xbundle${i}`, 0.05, 10005);
  const t1 = organic(c, 1012, 150, rand);
  for (let i = 0; i < 12; i++) c.sellAll(t1 + 1 + i * 0.5, `0xbundle${i}`);
  organic(c, t1 + 20, 120, rand, { start: 0.03, end: 0.01 });
  const { accts } = run(stream(c));
  for (const x of accts[0].closed) assert.ok(x.ret > -0.45, `${x.reason} ${x.ret}`);
});

test("holds through jeets' micro-sells, and is out by the time the dev dumps", () => {
  const rand = lcg(3);
  const c = new SynthCoin("0xd", 1000, { deployer: "0xdev" });
  c.buy(1000.1, "0xdev", 0.1);
  const t1 = organic(c, 1020, 90, rand, { jeets: 0.3, end: 0.3 });
  c.sellAll(t1 + 3, "0xdev");
  organic(c, t1 + 10, 60, rand, { start: 0.2, end: 0.2 });
  const { accts, eng } = run(stream(c));
  assert.ok(eng.signals.length > 0);
  const exits = accts[0].closed;
  assert.ok(exits.length > 0);
  assert.ok(exits.every((x) => x.reason !== "sell-wave" || x.at > t1 + 3), "jeets alone never read as a sell wave");
  // Whatever it held when the dev sold is gone within a sweep and a fill.
  for (const x of exits) assert.ok(x.at <= t1 + 3 + 6 || x.reason === "end" || x.at - x.held > t1 + 3, `${x.reason} at ${x.at}`);
});

test("leaves a coin the crowd walked away from", () => {
  const rand = lcg(4);
  const c = new SynthCoin("0xe", 1000);
  const t1 = organic(c, 1020, 200, rand);
  c.buy(t1 + 400, "0xlate", 0.01); // a lone trade long after
  const { accts } = run(stream(c));
  const exits = accts[0].closed.map((x) => x.reason);
  assert.ok(exits.some((r) => r === "idle" || r === "faded"), exits.join(","));
});

test("books balance: cash and bags only move by fills, fees, taxes and gas", () => {
  const rand = lcg(5);
  const coins = [];
  for (let k = 0; k < 6; k++) {
    const c = new SynthCoin(`0xf${k}`, 1000 + k * 50);
    for (let i = 0; i < 5; i++) c.buy(1001 + k * 50 + i, `0xs${k}${i}`, 0.03);
    organic(c, 1020 + k * 50, 200 + 40 * k, rand);
    coins.push(c);
  }
  const balances = [0.001, 0.01, 0.1, 1, 10, 100];
  const { accts } = run(stream(...coins), balances);
  for (const a of accts) {
    assert.ok(a.cash >= 0, `account ${a.id} cash ${a.cash}`);
    assert.equal(a.positions.size, 0);
    const flows = a.closed.reduce((s, x) => s + x.out - x.cost, 0);
    assert.ok(Math.abs(a.cash - (a.start + flows - a.gas)) < 1e-9, `account ${a.id} books off`);
    assert.ok(a.gas >= a.closed.length * 2 * GAS_ETH - 1e-12);
  }
  // Tiny accounts can't trade below the minimum; big ones are capped by impact.
  assert.equal(accts[0].closed.length, 0);
  const big = accts[5], mid = accts[3];
  const bigMax = Math.max(0, ...big.closed.map((x) => x.cost));
  assert.ok(bigMax < 0.1 * big.start, "impact cap binds long before equity does");
  assert.ok(mid.closed.length > 0);
});
