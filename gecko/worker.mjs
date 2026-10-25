// GeckoTerminal adapter for DoublePlus bonding curves (GeckoTerminal
// Integration API Standards v0.1): GeckoTerminal polls these endpoints and
// charts every coin from its first curve trade.
//
//   GET /latest-block                       -> { block }
//   GET /asset?id=0x…                       -> { asset }
//   GET /pair?id=<coin address>             -> { pair }   one pair per coin: coin/WETH on its curve
//   GET /events?fromBlock=N&toBlock=M       -> { events } swaps from CurveBuy/CurveSell, an exit at graduation
//
// Reserves after each trade are rebuilt from the event alone. A curve's base
// price and slope never change (factory.terms), the price after a trade fixes
// how many whole tokens are sold, and the integral of the curve gives the ETH
// it holds. Historical state isn't needed, which matters because the chain's
// nodes prune it. After graduation the coin trades in its Uniswap v4 pool,
// which GeckoTerminal already indexes as uniswap-v4-robinhood.
//
// Two systems run side by side (a redeploy leaves the old coins on the old
// one): v1, below, and v2 from the V2_FACTORY / V2_CURVE_DESK /
// V2_START_BLOCK vars (empty until it is deployed). On v2 a curve trade's fee
// and the coin's founder tax go to the curve desk, which reports both in its
// CurveCharged event just before the factory's CurveBuy/CurveSell; v1's fee
// is summed from FeeAccrued as before.

import { keccak_256 } from "@noble/hashes/sha3";
import { bytesToHex } from "@noble/hashes/utils";

const FACTORY = "0x60e0DD86327F1dA36565c79aAe9f87070415963b"; // v1
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const START_BLOCK = 94774769;
const CURVE_SUPPLY_WHOLE = 600_000_000n;
const CURVE_FEE_BPS = 100;
const DEX_KEY = "doubleplus";
const MAX_SPAN = 10_000; // blocks per /events request
const SAFETY_BLOCKS = 2; // /latest-block trails the head by this much
const E18 = 10n ** 18n;

// Event topics (keccak256 of the signatures in VentureFactory.sol).
const CURVE_BUY = "0x98d12e891d258a97e070380dba478a6f97d343fa7f30435e0a47293deb1ae772"; // CurveBuy(address,address,uint256,uint256,uint128)
const CURVE_SELL = "0x76ed02b1492ecb63b25e9bae4716913a9cbe4620c7b980d8b57ef1469c049251"; // CurveSell(address,address,uint256,uint256,uint128,uint256)
const FEE_ACCRUED = "0xd0d8d553933ef60036b53477b6f0af840f1f8b6642315c929b423cb682e5f100"; // FeeAccrued(address,address,uint256)
const GRADUATED = "0xdf9e4d7e38c0b4f9b2b0c31c082370dd912b89a99ebaf6129c106a6b81253f67"; // Graduated(address,bytes32,uint256,uint256,uint256)
const CURVE_CHARGED = topic("CurveCharged(address,address,address,bool,uint256,uint256,uint256,uint256,uint256)"); // v2 desk

// Function selectors.
const SEL = {
  curveBuyFeeBps: selector("curveBuyFeeBps()"),
  feePolicyOf: selector("feePolicyOf(address)"),
  listings: "0x65d96c82",
  terms: "0xc8c819ac",
  curveState: "0x19076e27",
  name: "0x06fdde03",
  symbol: "0x95d89b41",
  decimals: "0x313ce567",
  totalSupply: "0x18160ddd",
};

function topic(sig) { return "0x" + bytesToHex(keccak_256(new TextEncoder().encode(sig))); }
function selector(sig) { return topic(sig).slice(0, 10); }

/** The systems to index: v1 always, v2 once its vars are set. */
function systems(env) {
  const out = [{ factory: FACTORY, desk: null, start: START_BLOCK }];
  const f = String(env.V2_FACTORY ?? "").trim(), d = String(env.V2_CURVE_DESK ?? "").trim(), b = String(env.V2_START_BLOCK ?? "").trim();
  if (/^0x[0-9a-fA-F]{40}$/.test(f) && /^0x[0-9a-fA-F]{40}$/.test(d) && /^\d+$/.test(b)) out.push({ factory: f, desk: d, start: Number(b) });
  return out;
}

const HEADERS = { "Content-Type": "application/json", "Cache-Control": "no-store", "Access-Control-Allow-Origin": "*" };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: HEADERS });

// ---------------------------------------------------------------- RPC

let rpcId = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** One JSON-RPC call to one endpoint, retried briefly when it's throttled. */
async function rpcAt(url, method, params) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }) });
    if (r.status === 429 && attempt < 2) { await sleep(400 * (attempt + 1)); continue; }
    if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
    const j = await r.json();
    if (j.error) throw new Error(`${url} ${j.error.message}`);
    return j.result;
  }
}
async function rpc(env, method, params) {
  const urls = String(env.RPC_URL).split(",").map((u) => u.trim()).filter(Boolean);
  let last;
  for (const url of urls) {
    try { return await rpcAt(url, method, params); } catch (e) { last = e; }
  }
  throw last ?? new Error("no RPC");
}

/** eth_getLogs over [from, to], tried provider by provider, each within its
 *  own block-range cap (LOG_RPC: "url|maxBlocks,url|maxBlocks,…"). */
async function getLogs(env, address, from, to) {
  const providers = String(env.LOG_RPC).split(",").map((p) => p.trim()).filter(Boolean)
    .map((p) => { const [url, max] = p.split("|"); return { url, max: Number(max) || 2000 }; });
  let last;
  for (const { url, max } of providers) {
    try {
      const out = [];
      for (let a = from; a <= to; a += max) {
        const b = Math.min(a + max - 1, to);
        out.push(...(await rpcAt(url, "eth_getLogs", [{ address, fromBlock: "0x" + a.toString(16), toBlock: "0x" + b.toString(16) }])));
      }
      return out;
    } catch (e) { last = e; }
  }
  throw last ?? new Error("no log RPC");
}
const call = (env, to, data) => rpc(env, "eth_call", [{ to, data }, "latest"]);

// ---------------------------------------------------------------- ABI helpers

const word = (hex, i) => hex.slice(2 + i * 64, 2 + (i + 1) * 64);
const uint = (hex, i) => BigInt("0x" + word(hex, i));
const addr = (w) => "0x" + w.slice(24);
const padAddr = (a) => a.toLowerCase().replace(/^0x/, "").padStart(64, "0");

function decodeString(hex) {
  if (!hex || hex === "0x") return "";
  const data = hex.slice(2);
  // Dynamic string: offset, length, bytes. Fall back to bytes32.
  if (data.length >= 128) {
    const off = Number(BigInt("0x" + data.slice(0, 64))) * 2;
    const len = Number(BigInt("0x" + data.slice(off, off + 64)));
    const bytes = data.slice(off + 64, off + 64 + len * 2);
    return new TextDecoder().decode(Uint8Array.from(bytes.match(/../g) ?? [], (b) => parseInt(b, 16)));
  }
  return new TextDecoder().decode(Uint8Array.from(data.match(/../g) ?? [], (b) => parseInt(b, 16))).replace(/\0+$/, "");
}

// EIP-55 checksum, so ids match the explorer's format.
function checksum(a) {
  const lower = a.toLowerCase().replace(/^0x/, "");
  const hash = bytesToHex(keccak_256(new TextEncoder().encode(lower)));
  let out = "0x";
  for (let i = 0; i < 40; i++) out += parseInt(hash[i], 16) >= 8 ? lower[i].toUpperCase() : lower[i];
  return out;
}

// Exact decimal strings from integer amounts (no floats anywhere).
function decimal(v, decimals) {
  const neg = v < 0n; if (neg) v = -v;
  const s = v.toString().padStart(decimals + 1, "0");
  const int = s.slice(0, s.length - decimals), frac = s.slice(s.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}
/** a / b as a decimal string with up to 50 places. */
function ratio(a, b, places = 50) {
  const scaled = (a * 10n ** BigInt(places)) / b;
  return decimal(scaled, places);
}

// ---------------------------------------------------------------- chain reads

const termsCache = new Map(); // coin -> { p0, k } (immutable)
async function curveTerms(env, coin, factory = FACTORY) {
  const key = coin.toLowerCase();
  if (termsCache.has(key)) return termsCache.get(key);
  const r = await call(env, factory, SEL.terms + padAddr(coin));
  // (uint16 founderRaiseBps, uint256 maxBuyWei, address vesting, uint128 basePriceWei, uint128 slopeQ, uint8 mode, bool swept)
  const t = { p0: uint(r, 3), k: uint(r, 4) };
  if (t.p0 === 0n) throw new Error(`not a DoublePlus coin: ${coin}`);
  termsCache.set(key, t);
  return t;
}

const blockCache = new Map();
async function blockTime(env, n) {
  if (blockCache.has(n)) return blockCache.get(n);
  const b = await rpc(env, "eth_getBlockByNumber", ["0x" + n.toString(16), false]);
  const t = Number(BigInt(b.timestamp));
  if (blockCache.size > 5000) blockCache.clear();
  blockCache.set(n, t);
  return t;
}

/** Order the two assets alphabetically, as the standard asks when a curve
 *  has no on-chain token0/token1. Returns [asset0, asset1, coinIsAsset0]. */
function order(coin) {
  const coinFirst = coin.toLowerCase() < WETH.toLowerCase();
  return coinFirst ? [checksum(coin), WETH, true] : [WETH, checksum(coin), false];
}

// ---------------------------------------------------------------- curve math

/** Whole tokens sold at a given curve price: price = p0 + k·S/1e18. */
function soldAt(t, priceWei) {
  if (t.k === 0n) return null;
  const d = priceWei - t.p0;
  if (d <= 0n) return 0n;
  return (d * E18 + t.k / 2n) / t.k; // nearest whole token
}
const priceAt = (t, sold) => t.p0 + (t.k * sold) / E18;
/** ETH the curve holds once `sold` whole tokens are out: ∫ price dS. */
const raisedAt = (t, sold) => sold * t.p0 + (t.k * sold * sold) / (2n * E18);

/** Reserves and price for the pair, oriented to asset0/asset1. */
function state(t, sold, coinIsAsset0) {
  const coinRes = decimal((CURVE_SUPPLY_WHOLE - sold) * E18, 18);
  const ethRes = decimal(raisedAt(t, sold), 18);
  const price = priceAt(t, sold); // wei per whole token = ETH per token × 1e18
  return coinIsAsset0
    ? { reserves: { asset0: coinRes, asset1: ethRes }, priceNative: ratio(price, E18) }
    : { reserves: { asset0: ethRes, asset1: coinRes }, priceNative: ratio(E18, price) };
}

// ---------------------------------------------------------------- endpoints

// GeckoTerminal polls this every 2 s; one RPC read per second is plenty.
let headMemo = { at: 0, value: null };
async function latestBlock(env) {
  if (headMemo.value && Date.now() - headMemo.at < 1000) return headMemo.value;
  const head = Number(BigInt(await rpc(env, "eth_blockNumber", [])));
  const n = Math.max(START_BLOCK, head - SAFETY_BLOCKS);
  headMemo = { at: Date.now(), value: { block: { blockNumber: n, blockTimestamp: await blockTime(env, n) } } };
  return headMemo.value;
}

async function asset(env, id) {
  const [name, symbol, decimals, supply] = await Promise.all([
    call(env, id, SEL.name), call(env, id, SEL.symbol), call(env, id, SEL.decimals), call(env, id, SEL.totalSupply),
  ]);
  const dec = Number(BigInt(decimals));
  const out = { id: checksum(id), name: decodeString(name) || "Unknown", symbol: decodeString(symbol) || "?", decimals: dec, totalSupply: decimal(BigInt(supply), dec) };
  if (id.toLowerCase() !== WETH.toLowerCase()) out.circulatingSupply = out.totalSupply;
  else out.coinGeckoId = "weth";
  return { asset: out };
}

async function pair(env, id) {
  for (const sys of systems(env)) {
    const r = await call(env, sys.factory, SEL.listings + padAddr(id));
    // (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)
    const creator = addr(word(r, 0));
    if (/^0x0{40}$/.test(creator)) continue;
    await curveTerms(env, id, sys.factory); // reject anything that isn't a curve
    const [asset0Id, asset1Id] = order(id);
    // v2: the curve fee plus the coin's buy tax, which the desk takes with it.
    let feeBps = CURVE_FEE_BPS;
    if (sys.desk) {
      const [fee, policy] = await Promise.all([call(env, sys.factory, SEL.curveBuyFeeBps), call(env, sys.factory, SEL.feePolicyOf + padAddr(id))]);
      feeBps = Number(BigInt(fee)) + Number(uint(policy, 1));
    }
    return {
      pair: {
        id: checksum(id), dexKey: DEX_KEY, asset0Id, asset1Id,
        createdAtBlockTimestamp: Number(uint(r, 3)), creator: checksum(creator), feeBps,
      },
    };
  }
  return null;
}

async function events(env, from, to) {
  // Each log is tagged with its system; a desk's logs only carry CurveCharged.
  const factoryOf = new Map(); // coin -> its factory (each coin lives on one)
  const rel = [];
  for (const sys of systems(env)) {
    const a = Math.max(from, sys.start);
    if (a > to) continue;
    const isV2 = !!sys.desk;
    const wanted = new Set([CURVE_BUY, CURVE_SELL, GRADUATED, ...(isV2 ? [] : [FEE_ACCRUED])]);
    for (const l of await getLogs(env, sys.factory, a, to)) {
      if (l.removed || !wanted.has(l.topics[0])) continue;
      factoryOf.set(addr(l.topics[1].slice(2)).toLowerCase(), sys.factory);
      rel.push(l);
    }
    if (isV2) for (const l of await getLogs(env, sys.desk, a, to)) if (!l.removed && l.topics[0] === CURVE_CHARGED) rel.push(l);
  }
  rel.sort((a, b) => Number(BigInt(a.blockNumber) - BigInt(b.blockNumber)) || Number(BigInt(a.logIndex) - BigInt(b.logIndex)));

  const out = [];
  const feeSince = new Map(); // txHash|coin -> fee wei accrued since that tx's last curve event
  const lastSold = new Map(); // coin -> whole tokens sold after its last event here
  for (const l of rel) {
    const topic = l.topics[0];
    const coin = addr(l.topics[1].slice(2));
    const key = `${l.transactionHash}|${coin.toLowerCase()}`;
    if (topic === FEE_ACCRUED) {
      feeSince.set(key, (feeSince.get(key) ?? 0n) + uint(l.data, 0));
      continue;
    }
    if (topic === CURVE_CHARGED) {
      // CurveCharged(coin, trader, referrer, isBuy, fee, tax, …): the whole
      // charge, fee and founder tax, taken in the same trade.
      feeSince.set(key, (feeSince.get(key) ?? 0n) + uint(l.data, 1) + uint(l.data, 2));
      continue;
    }
    const t = await curveTerms(env, coin, factoryOf.get(coin.toLowerCase()));
    const [, , coinIsAsset0] = order(coin);
    const blockNumber = Number(BigInt(l.blockNumber));
    const base = {
      block: { blockNumber, blockTimestamp: await blockTime(env, blockNumber) },
      txnId: l.transactionHash, txnIndex: Number(BigInt(l.transactionIndex)), eventIndex: Number(BigInt(l.logIndex)),
      pairId: checksum(coin),
    };
    const coinSide = coinIsAsset0 ? "0" : "1", ethSide = coinIsAsset0 ? "1" : "0";

    if (topic === CURVE_BUY) {
      // CurveBuy(token, buyer, ethIn, tokensOut, priceWei): ethIn is what
      // reached the curve; the fee accrued just before it in the same tx.
      const ethIn = uint(l.data, 0), tokensOut = uint(l.data, 1), priceBefore = uint(l.data, 2);
      const fee = feeSince.get(key) ?? 0n; feeSince.delete(key);
      const before = soldAt(t, priceBefore) ?? lastSold.get(coin.toLowerCase()) ?? 0n;
      const sold = before + tokensOut / E18;
      lastSold.set(coin.toLowerCase(), sold);
      const s = state(t, sold, coinIsAsset0);
      out.push({
        ...base, eventType: "swap", maker: checksum(addr(l.topics[2].slice(2))),
        [`asset${ethSide}In`]: decimal(ethIn + fee, 18), [`asset${coinSide}Out`]: decimal(tokensOut, 18),
        priceNative: s.priceNative, reserves: s.reserves,
        metadata: { [`fees${ethSide}In`]: decimal(fee, 18) },
      });
    } else if (topic === CURVE_SELL) {
      // CurveSell(token, seller, ethOut, tokensIn, priceWei, feeWei): the
      // price is after the sell; the curve paid out ethOut + fee.
      // v2: the desk's CurveCharged (fee + tax) replaces feeWei, which is the fee alone.
      const v2 = factoryOf.get(coin.toLowerCase()) !== FACTORY;
      const ethOut = uint(l.data, 0), tokensIn = uint(l.data, 1), priceAfter = uint(l.data, 2);
      const fee = v2 ? (feeSince.get(key) ?? uint(l.data, 3)) : uint(l.data, 3);
      feeSince.delete(key);
      const sold = soldAt(t, priceAfter) ?? 0n;
      lastSold.set(coin.toLowerCase(), sold);
      const s = state(t, sold, coinIsAsset0);
      out.push({
        ...base, eventType: "swap", maker: checksum(addr(l.topics[2].slice(2))),
        [`asset${coinSide}In`]: decimal(tokensIn, 18), [`asset${ethSide}Out`]: decimal(ethOut + fee, 18),
        priceNative: s.priceNative, reserves: s.reserves,
        metadata: { [`fees${ethSide}Out`]: decimal(fee, 18) },
      });
    } else if (topic === GRADUATED) {
      // The curve's ETH and tokens move to the Uniswap v4 pool: an exit that
      // empties the curve pair. The pool itself is indexed as Uniswap v4.
      const sold = lastSold.get(coin.toLowerCase()) ?? (await soldNow(env, coin, factoryOf.get(coin.toLowerCase())));
      const s = state(t, sold, coinIsAsset0);
      const tx = await rpc(env, "eth_getTransactionByHash", [l.transactionHash]);
      out.push({
        ...base, eventType: "exit", maker: checksum(tx.from),
        amount0: s.reserves.asset0, amount1: s.reserves.asset1, reserves: { asset0: "0", asset1: "0" },
      });
    }
  }
  return { events: out };
}

async function soldNow(env, coin, factory = FACTORY) {
  // curveState(token): (uint64 deadline, uint128 price, uint256 soldWhole, ...)
  const r = await call(env, factory, SEL.curveState + padAddr(coin));
  return uint(r, 2);
}

// ---------------------------------------------------------------- router

const isAddress = (s) => /^0x[0-9a-fA-F]{40}$/.test(s ?? "");
const isBlock = (s) => /^\d{1,12}$/.test(s ?? "");

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET") return json({ error: "GET only" }, 405);
    try {
      if (url.pathname === "/latest-block") return json(await latestBlock(env));
      if (url.pathname === "/asset") {
        const id = url.searchParams.get("id");
        if (!isAddress(id)) return json({ error: "id must be an address" }, 400);
        return json(await asset(env, id));
      }
      if (url.pathname === "/pair") {
        const id = url.searchParams.get("id");
        if (!isAddress(id)) return json({ error: "id must be a coin address" }, 400);
        const p = await pair(env, id);
        return p ? json(p) : json({ error: "not a DoublePlus coin" }, 404);
      }
      if (url.pathname === "/events") {
        const f = url.searchParams.get("fromBlock"), t = url.searchParams.get("toBlock");
        if (!isBlock(f) || !isBlock(t)) return json({ error: "fromBlock and toBlock must be block numbers" }, 400);
        const from = Math.max(Number(f), START_BLOCK), to = Number(t);
        if (to < from) return json({ events: [] });
        if (to - from + 1 > MAX_SPAN) return json({ error: `at most ${MAX_SPAN} blocks per request` }, 400);
        return json(await events(env, from, to));
      }
      if (url.pathname === "/" || url.pathname === "/health") return json({ ok: true, dexKey: DEX_KEY, factory: FACTORY, factories: systems(env).map((s) => s.factory) });
      return json({ error: "not found" }, 404);
    } catch (e) {
      console.log(JSON.stringify({ p: url.pathname, q: url.search, err: String(e?.message ?? e).slice(0, 300) }));
      return json({ error: "upstream error, retry" }, 503);
    }
  },
};
