// doubleplus venture ops keeper — the launchpad runs itself.
//
// Every run, for every venture on the factory:
//   1) finalize() any curve that hit its target (or sold out) — backers never
//      wait for a human to click Graduate;
//   2) abort() any raise past its deadline below target — refunds open the
//      minute they should;
//   3) deliver dividends: snapshot holders from the coin's Transfer log and
//      batch claimForMany() for everyone with pendingRewards above the
//      threshold — yield lands in wallets with no user action. claimFor can
//      only ever push a holder's rewards to the holder themselves, so this
//      keeper cannot divert a wei.
//
// Env:
//   KEEPER_PRIVATE_KEY  (required) pays gas
//   RPC_URL             (default https://rpc.testnet.chain.robinhood.com)
//   CHAIN_ID            (default 46630) picks the deployment file: 4663 ->
//                       venture-robinhood.json, 46630 -> venture-testnet.json.
//                       Must agree with RPC_URL or the run aborts; any other
//                       chain needs DEPLOYMENT_FILE.
//   DEPLOYMENT_FILE     explicit override for the above
//   MIN_DELIVER         (default 1e12 wei of the reward token)
//   RECENTER_SPACINGS   (default 10) recenter walls whose near edge drifted
//                       more than this many tick-spacings from the price
//   LOG_CHUNK           (default 500000) block span per getLogs page
//   CONFIRMATIONS       (default 3)
//   DRY_RUN             set to log intended actions without sending txs
//   MAX_SPEND_ETH       (default 0.01) gas this run may spend before it stops;
//                       bounds what a flood of spam coins can cost the treasury
//   DELIVER_GAS_MULT    (default 4) a payout is only pushed when it is worth at
//                       least this many times the gas it costs to push
import { ethers } from "ethers";

import { DRY_RUN, envEth, envInt, envWei, KEY, loadDeployment, LOG_CHUNK, RPC } from "./venture-config.mjs";

const { dep, depPath } = loadDeployment();
const MIN_DELIVER = envWei("MIN_DELIVER", 1_000_000_000_000n);
const RECENTER_SPACINGS = envInt("RECENTER_SPACINGS", 10, 1, 10_000);
const SPACING = 60; // the factory's pools all use tickSpacing 60
const CONFIRMATIONS = envInt("CONFIRMATIONS", 3, 0, 64);
const MAX_SPEND_WEI = envEth("MAX_SPEND_ETH", "0.01");
const DELIVER_GAS_MULT = BigInt(envInt("DELIVER_GAS_MULT", 4, 1, 1000));
// Gas one holder adds to a claimForMany batch, measured on testnet, with room.
const GAS_PER_DELIVERY = 60_000n;

// Every tx goes through send(): it counts what the run has spent and refuses
// to go past MAX_SPEND_WEI, so spam can cost a run at most that much.
const stats = { sent: 0, spentWei: 0n, graduated: 0, aborted: 0, skippedEmptyAborts: 0, delivered: 0, recentered: 0, stoppedAtCap: false, failed: 0 };
class SpendCap extends Error {}
async function send(label, fn) {
  if (DRY_RUN) return;
  if (stats.spentWei >= MAX_SPEND_WEI) { stats.stoppedAtCap = true; throw new SpendCap(label); }
  const rc = await (await fn()).wait();
  stats.sent++;
  stats.spentWei += (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? rc?.effectiveGasPrice ?? 0n);
}

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const FACTORY_ABI = [
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function curveState(address) view returns (uint64 deadline, uint128 price, uint256 soldWhole, uint256 remainingWhole, uint256 raisedWei, uint256 targetRaiseWei, bool finalized, bool aborted)",
  "function vestingOf(address) view returns (address)",
  "function finalize(address) returns (bytes32)",
  "function abort(address)",
  "function terms(address) view returns (uint16 founderRaiseBps, uint256 maxBuyWei, address vesting, uint128 basePriceWei, uint128 slopeQ, uint8 mode, bool swept)",
  "event FeeAccrued(address indexed token, address indexed recipient, uint256 amount)",
  "event FeesWithdrawn(address indexed recipient, uint256 amount)",
];
const TOKEN_ABI = [
  "function pendingRewards(address) view returns (uint256)",
  "function claimForMany(address[])",
];
const HOOK_ABI = [
  "function lastSwapAt(bytes32) view returns (uint64)",
  "function poolTick(address) view returns (int24)",
  "function recenter(address coin, (int24 lower, int24 upper, uint128 liquidity)[] bands)",
  "event LiquidityAdded(bytes32 indexed id, address currency, uint256 amount, uint128 liquidity, bool wall, int24 tickLower, int24 tickUpper)",
  "event WallRemoved(bytes32 indexed id, int24 tickLower, int24 tickUpper, uint128 liquidity)",
];
const LISTINGS_ABI = ["function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)"];

const provider = new ethers.JsonRpcProvider(RPC);
{
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    for (let i = 0; ; i++) {
      try { return await origSend(method, params); }
      catch (e) {
        const msg = String(e?.message ?? e);
        const transient = /rate|limit|429|timeout|ETIMEDOUT|ECONNRESET|503|502/i.test(msg);
        if (!transient || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  };
}
const wallet = new ethers.Wallet(KEY, provider);
const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, wallet);
const factoryListings = new ethers.Contract(dep.contracts.factory, LISTINGS_ABI, wallet);
const hook = new ethers.Contract(dep.contracts.hook, HOOK_ABI, wallet);

/** Live wall set for a pool: LiquidityAdded(wall) minus WallRemoved, netted
 *  per (lower, upper) band. */
async function wallBands(poolId, toBlock) {
  const from = Number(dep.startBlock ?? 0);
  const bands = new Map(); // "lower:upper" -> liquidity
  const addTopic = hook.interface.getEvent("LiquidityAdded").topicHash;
  const remTopic = hook.interface.getEvent("WallRemoved").topicHash;
  for (let start = from; start <= toBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, toBlock);
    const logs = await provider.getLogs({
      address: dep.contracts.hook, topics: [[addTopic, remTopic], poolId], fromBlock: start, toBlock: end,
    });
    for (const l of logs) {
      if (l.topics[0] === addTopic) {
        const a = hook.interface.parseLog(l).args;
        if (!a.wall) continue;
        const k = `${a.tickLower}:${a.tickUpper}`;
        bands.set(k, (bands.get(k) ?? 0n) + BigInt(a.liquidity));
      } else {
        const a = hook.interface.parseLog(l).args;
        const k = `${a.tickLower}:${a.tickUpper}`;
        bands.set(k, (bands.get(k) ?? 0n) - BigInt(a.liquidity));
      }
    }
  }
  return [...bands.entries()]
    .filter(([, liq]) => liq > 0n)
    .map(([k, liquidity]) => {
      const [lower, upper] = k.split(":").map(Number);
      return { lower, upper, liquidity };
    });
}

/** Migrate stale quote walls back beside the price when they have drifted. */
async function maybeRecenter(coin, poolId, toBlock) {
  const bands = await wallBands(poolId, toBlock);
  if (bands.length === 0) return;
  const tick = Number(await hook.poolTick(coin));
  const maxDrift = RECENTER_SPACINGS * SPACING;
  const stale = bands.some((b) => {
    const nearEdge = tick < b.lower ? b.lower : tick > b.upper ? b.upper : tick;
    return Math.abs(tick - nearEdge) > maxDrift;
  });
  if (!stale) return;
  // The hook refuses a recenter until the pool has been quiet for a minute
  // (so nobody can recenter beside a price they just pushed). Don't pay gas
  // for a tx that would revert; the next run catches it.
  const last = Number(await hook.lastSwapAt(poolId).catch(() => 0n));
  if (Math.floor(Date.now() / 1000) < last + 60) { console.log(`recenter ${coin}: price still moving, later`); return; }
  console.log(`recenter ${coin}: ${bands.length} wall band(s), tick ${tick}`);
  await send(`recenter ${coin}`, () => hook.recenter(coin, bands));
  stats.recentered++;
}

async function holdersOf(coin, toBlock) {
  const balances = new Map();
  const from = Number(dep.startBlock ?? 0);
  for (let start = from; start <= toBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, toBlock);
    const logs = await provider.getLogs({ address: coin, topics: [TRANSFER_TOPIC], fromBlock: start, toBlock: end });
    for (const l of logs) {
      const fromA = ethers.getAddress("0x" + l.topics[1].slice(26));
      const toA = ethers.getAddress("0x" + l.topics[2].slice(26));
      const v = BigInt(l.data);
      if (v === 0n) continue;
      balances.set(fromA, (balances.get(fromA) ?? 0n) - v);
      balances.set(toA, (balances.get(toA) ?? 0n) + v);
    }
  }
  const system = new Set(
    [ZERO, DEAD, dep.contracts.poolManager, dep.contracts.factory, dep.contracts.router, dep.contracts.hook, coin]
      .map((a) => a.toLowerCase()),
  );
  return [...balances.entries()]
    .filter(([a, b]) => b > 0n && !system.has(a.toLowerCase()))
    .map(([a]) => a);
}

async function main() {
  // The deployment file and the RPC must describe the same chain. Without this
  // a mainnet RPC with testnet addresses reads zeroes from contracts that do
  // not exist there, and the keeper reports "0 ventures" and exits clean —
  // looking healthy while doing nothing.
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(dep.chainId)) {
    console.error(
      `chain mismatch: RPC is ${net.chainId}, ${depPath} is for ${dep.chainId}.
` +
      `Set CHAIN_ID=${net.chainId} (or DEPLOYMENT_FILE) to match RPC_URL.`,
    );
    process.exit(1);
  }
  const head = (await provider.getBlockNumber()) - CONFIRMATIONS;
  const now = Math.floor(Date.now() / 1000);
  const total = Number(await factory.totalTokens());
  console.log(`venture-ops: ${total} ventures, head-${CONFIRMATIONS}=${head}, keeper=${wallet.address}${DRY_RUN ? " [DRY_RUN]" : ""}`);

  // A payout is only worth pushing if it beats the gas to push it, with margin;
  // otherwise splitting a bag across thousands of wallets would make the
  // keeper pay more in gas than it delivers.
  const fee = await provider.getFeeData();
  const gasPrice = fee.gasPrice ?? fee.maxFeePerGas ?? 0n;
  const gasFloor = GAS_PER_DELIVERY * gasPrice * DELIVER_GAS_MULT;
  const minDeliver = gasFloor > MIN_DELIVER ? gasFloor : MIN_DELIVER;
  const balance = await provider.getBalance(wallet.address);
  if (balance < MAX_SPEND_WEI) console.log(`WARNING keeper balance ${ethers.formatEther(balance)} ETH is below one run's cap`);

  for (let i = 0; i < total; i++) {
    const coin = await factory.allTokens(i);
    try {
      await processCoin(coin, now, head, minDeliver);
    } catch (e) {
      if (e instanceof SpendCap) { console.log(`spend cap reached at ${e.message}; stopping this run`); break; }
      // One coin failing must not stop the rest: a single hostile or broken
      // coin would otherwise block refunds and payouts for every later one.
      stats.failed++;
      console.log(`coin ${coin} failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
  }
  const solvency = await checkSolvency(total, head);
  console.log(JSON.stringify({ keeper: "venture-ops", solvency, chain: Number(dep.chainId), ventures: total, ...stats, spentWei: stats.spentWei.toString(), minDeliver: minDeliver.toString(), balanceWei: balance.toString() }));
}

/**
 * The factory must always hold at least what it owes: the ETH escrowed in
 * every raise that hasn't graduated or been swept, plus every fee credited
 * and not yet withdrawn (reconstructed from FeeAccrued and FeesWithdrawn).
 * A shortfall means a bug or an exploit; the run then exits non-zero, which
 * fails the workflow and notifies the repo owner.
 */
async function checkSolvency(total, head) {
  let escrow = 0n;
  for (let i = 0; i < total; i++) {
    const coin = await factory.allTokens(i);
    const [st, t] = await Promise.all([factory.curveState(coin), factory.terms(coin)]);
    if (!st.finalized && !t.swept) escrow += st.raisedWei;
  }
  let accrued = 0n, withdrawn = 0n;
  const from = Number(dep.startBlock ?? 0);
  for (let start = from; start <= head; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, head);
    const [a, w] = await Promise.all([
      factory.queryFilter(factory.filters.FeeAccrued(), start, end),
      factory.queryFilter(factory.filters.FeesWithdrawn(), start, end),
    ]);
    for (const l of a) accrued += BigInt(l.args.amount);
    for (const l of w) withdrawn += BigInt(l.args.amount);
  }
  const owed = escrow + (accrued - withdrawn);
  const balance = await provider.getBalance(dep.contracts.factory, head);
  const ok = balance >= owed;
  if (!ok) {
    console.error(`CRITICAL factory insolvent: holds ${ethers.formatEther(balance)} ETH, owes ${ethers.formatEther(owed)} (escrow ${ethers.formatEther(escrow)}, fees ${ethers.formatEther(accrued - withdrawn)})`);
    process.exitCode = 2;
  }
  return { ok, balanceWei: balance.toString(), owedWei: owed.toString(), escrowWei: escrow.toString(), feesOwedWei: (accrued - withdrawn).toString() };
}

async function processCoin(coin, now, head, minDeliver) {
  {
    const st = await factory.curveState(coin);

    if (!st.finalized && !st.aborted) {
      const targetHit = st.raisedWei >= st.targetRaiseWei || st.remainingWhole === 0n;
      if (targetHit) {
        console.log(`graduate ${coin} (raised ${ethers.formatEther(st.raisedWei)} ETH)`);
        await send(`finalize ${coin}`, () => factory.finalize(coin));
        stats.graduated++;
      } else if (now >= Number(st.deadline)) {
        // Nobody's money is in a raise that raised nothing, so there is no
        // refund to open. Aborting it would only spend gas, which is exactly
        // what a flood of dead launches is for.
        if (st.raisedWei === 0n) { stats.skippedEmptyAborts++; return; }
        console.log(`abort ${coin} (deadline passed at ${ethers.formatEther(st.raisedWei)}/${ethers.formatEther(st.targetRaiseWei)} ETH)`);
        await send(`abort ${coin}`, () => factory.abort(coin));
        stats.aborted++;
      }
      return; // dividends only exist after graduation
    }
    if (!st.finalized) return;

    // Keep the quote walls hugging the price.
    try {
      const listing = await factoryListings.listings(coin);
      await maybeRecenter(coin, listing.poolId, head);
    } catch (e) {
      console.log(`recenter check failed for ${coin}: ${String(e?.message ?? e).slice(0, 120)}`);
    }

    const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
    const holders = await holdersOf(coin, head);
    const due = [];
    for (const h of holders) {
      try { if ((await token.pendingRewards(h)) >= minDeliver) due.push(h); } catch { /* skip */ }
    }
    if (due.length === 0) return;
    console.log(`deliver dividends on ${coin}: ${due.length} holder(s)`);
    for (let j = 0; j < due.length; j += 100) {
      const batch = due.slice(j, j + 100);
      await send(`claimForMany ${coin}`, () => token.claimForMany(batch));
      stats.delivered += batch.length;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
