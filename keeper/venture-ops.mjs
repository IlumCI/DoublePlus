// doubleplus venture ops keeper — the launchpad runs itself.
//
// Every run, for every venture on the factory:
//   1) finalize() any curve that hit its target (or sold out) — backers never
//      wait for a human to click Graduate;
//   2) abort() any raise past its deadline below target, then push every
//      backer's refund to their wallet with refundMany() — nobody has to
//      claim. The contract only pays a backer still holding what they bought;
//      anyone it skips can still claim on the site;
//   3) deliver dividends: snapshot holders from the coin's Transfer log and
//      batch claimForMany() for everyone with pendingRewards above the
//      threshold — yield lands in wallets with no user action. claimFor can
//      only ever push a holder's rewards to the holder themselves, so this
//      keeper cannot divert a wei;
//   4) pay out last-buyer pots whose clock ran out on a pool nobody has
//      traded since (any trade would have paid it already). claimPot only
//      ever pays the pot's leader.
//   5) holders at 5x who picked a payout (ETH, the coin, USDG, a stock) are
//      collected through VenturePayouts instead of claimForMany, with a
//      minimum out 2% under a simulation taken just before sending;
//   6) fill every limit order the pool can now meet. The order book enforces
//      the owner's price itself; the keeper earns the owner's tip.
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
const stats = { payoutsConverted: 0, limitFilled: 0, sent: 0, spentWei: 0n, graduated: 0, aborted: 0, skippedEmptyAborts: 0, refunded: 0, delivered: 0, recentered: 0, potsPaid: 0, stoppedAtCap: false, failed: 0 };
class SpendCap extends Error {}
async function send(label, fn) {
  if (DRY_RUN) return;
  if (stats.spentWei >= MAX_SPEND_WEI) { stats.stoppedAtCap = true; throw new SpendCap(label); }
  const cost = (rc) => (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? rc?.effectiveGasPrice ?? 0n);
  let rc;
  try {
    rc = await (await fn()).wait();
  } catch (e) {
    // A reverted tx still burned gas: count it, or anyone whose order or
    // payout reverts on chain (after passing the simulation) could drain the
    // keeper a run at a time without ever reaching the cap.
    if (e?.receipt) { stats.sent++; stats.spentWei += cost(e.receipt); }
    throw e;
  }
  stats.sent++;
  stats.spentWei += cost(rc);
  return rc;
}

// Gas ceilings for txs whose cost a stranger controls (an order owner's or a
// holder's contract receiving ETH can burn whatever gas it's given).
const FILL_GAS = 2_500_000n; // testnet fills peaked at 677k
const COLLECT_GAS = 1_200_000n;

// Batches that skip a failing item (claimForMany's try/catch, refundMany's
// gas-capped sends) can't be gas-estimated: the estimator only needs the
// outer call to succeed, so it settles on a limit that starves every item and
// the batch "succeeds" having paid nobody. Size them per item instead, and
// count what actually landed from the receipt.
const batchGas = (perItem, n) => 80_000n + perItem * BigInt(n);
const countEvents = (rc, address, topic) =>
  (rc?.logs ?? []).filter((l) => l.address.toLowerCase() === address.toLowerCase() && l.topics[0] === topic).length;
const REWARDS_CLAIMED = ethers.id("RewardsClaimed(address,uint256)");
const REFUNDED = ethers.id("Refunded(address,address,uint256,uint256)");

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
  "function spentWei(address, address) view returns (uint256)",
  "function boughtTokens(address, address) view returns (uint256)",
  "function refundMany(address token, address[] backers)",
  "event CurveBuy(address indexed token, address indexed buyer, uint256 ethIn, uint256 tokensOut, uint128 priceWei)",
  "event FeeAccrued(address indexed token, address indexed recipient, uint256 amount)",
  "event FeesWithdrawn(address indexed recipient, uint256 amount)",
];
const TOKEN_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function pendingRewards(address) view returns (uint256)",
  "function claimForMany(address[])",
  "function payoutAgent(address) view returns (address)",
  "function atAgentTier(address) view returns (bool)",
];
const PAYOUTS_ABI = [
  "function collect(address coin, address holder, uint256 minOut) returns (uint256)",
];
const LIMIT_ABI = [
  "function totalOrders() view returns (uint256)",
  "function order(uint256 id) view returns ((address owner, address coin, bool isBuy, uint16 tipBps, uint64 expiry, uint256 amountIn, uint256 minOut))",
  "function fill(uint256 id) returns (uint256)",
];
const PAYOUT_SLIPPAGE_BPS = 200n;
const HOOK_ABI = [
  "function lastSwapAt(bytes32) view returns (uint64)",
  "function poolTick(address) view returns (int24)",
  "function recenter(address coin, (int24 lower, int24 upper, uint128 liquidity)[] bands)",
  "function pot(address coin) view returns (uint256 pairAmount, uint256 coinAmount, address leader, uint64 deadline)",
  "function claimPot(address coin)",
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
const payouts = dep.contracts.payouts ? new ethers.Contract(dep.contracts.payouts, PAYOUTS_ABI, wallet) : null;
const limitOrders = dep.contracts.limitOrders ? new ethers.Contract(dep.contracts.limitOrders, LIMIT_ABI, wallet) : null;

/** Fill whatever open limit orders the pools can meet right now. A fill that
 *  would miss the owner's price reverts in simulation and is skipped. */
async function fillLimitOrders() {
  if (!limitOrders) return;
  const total = Number(await limitOrders.totalOrders());
  for (let id = 0; id < total; id++) {
    const o = await limitOrders.order(id);
    if (o.amountIn === 0n) continue;
    try {
      await limitOrders.fill.staticCall(id, { gasLimit: FILL_GAS });
    } catch { continue; } // not fillable yet
    console.log(`fill limit order ${id} (${o.isBuy ? "buy" : "sell"} ${o.coin})`);
    // One order failing on chain must not stop the orders after it.
    try {
      await send(`fill ${id}`, () => limitOrders.fill(id, { gasLimit: FILL_GAS }));
      stats.limitFilled++;
    } catch (e) {
      if (e instanceof SpendCap) throw e;
      stats.failed++;
      console.log(`fill ${id} failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
  }
}

/** Convert a 5x holder's dividends into what they picked. */
async function collectPayout(coin, holder) {
  const quoted = await payouts.collect.staticCall(coin, holder, 0n, { gasLimit: COLLECT_GAS });
  if (quoted === 0n) return;
  const minOut = (quoted * (10_000n - PAYOUT_SLIPPAGE_BPS)) / 10_000n;
  await send(`collect ${coin} ${holder}`, () => payouts.collect(coin, holder, minOut, { gasLimit: COLLECT_GAS }));
  stats.payoutsConverted++;
}

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
async function maybeRecenter(coin, poolId, toBlock, now) {
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
  if (now < last + 60) { console.log(`recenter ${coin}: price still moving, later`); return; }
  console.log(`recenter ${coin}: ${bands.length} wall band(s), tick ${tick}`);
  await send(`recenter ${coin}`, () => hook.recenter(coin, bands));
  stats.recentered++;
}

/** Push refunds for an aborted raise to every backer the contract would pay:
 *  ETH still escrowed for them, everything they bought still in their wallet,
 *  and worth more than the gas to send it. */
async function pushRefunds(coin, toBlock, minDeliver) {
  const backers = new Set();
  const from = Number(dep.startBlock ?? 0);
  for (let start = from; start <= toBlock; start += LOG_CHUNK) {
    const end = Math.min(start + LOG_CHUNK - 1, toBlock);
    for (const l of await factory.queryFilter(factory.filters.CurveBuy(coin), start, end)) backers.add(l.args.buyer);
  }
  const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
  const due = [];
  for (const b of backers) {
    const [spent, bought, held] = await Promise.all([factory.spentWei(coin, b), factory.boughtTokens(coin, b), token.balanceOf(b)]);
    if (spent >= minDeliver && held >= bought) due.push(b);
  }
  if (due.length === 0) return;
  console.log(`push refunds on ${coin}: ${due.length} backer(s)`);
  for (let j = 0; j < due.length; j += 100) {
    const batch = due.slice(j, j + 100);
    const rc = await send(`refundMany ${coin}`, () => factory.refundMany(coin, batch, { gasLimit: batchGas(120_000n, batch.length) }));
    const paid = countEvents(rc, factory.target, REFUNDED);
    if (paid < batch.length) console.log(`  refunded ${paid}/${batch.length}; the rest can still claim on the site`);
    stats.refunded += paid;
  }
}

/** Pay a pot whose clock ran out with no trade since to take it. */
async function maybePayPot(coin, now) {
  const p = await hook.pot(coin);
  if (p.leader === ZERO || now < Number(p.deadline)) return;
  console.log(`pay pot on ${coin} to ${p.leader}`);
  await send(`claimPot ${coin}`, () => hook.claimPot(coin));
  stats.potsPaid++;
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
    // The order book and payout router only hold coins in passing; pushing
    // rewards to them would strand WETH they have no way to pass on.
    [ZERO, DEAD, dep.contracts.poolManager, dep.contracts.factory, dep.contracts.router, dep.contracts.hook, coin,
      dep.contracts.limitOrders ?? ZERO, dep.contracts.payouts ?? ZERO]
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
  // Chain time, not this machine's clock: deadlines and pot clocks are
  // judged by block.timestamp, and the two can drift.
  const now = Number((await provider.getBlock("latest")).timestamp);
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
  try {
    await fillLimitOrders();
  } catch (e) {
    if (!(e instanceof SpendCap)) console.log(`limit orders failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
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
        if (!DRY_RUN) await pushRefunds(coin, await provider.getBlockNumber(), minDeliver);
      }
      return; // dividends only exist after graduation
    }
    if (!st.finalized) {
      // Aborted: refunds go out until the escrow is swept.
      if (!(await factory.terms(coin)).swept) await pushRefunds(coin, head, minDeliver);
      return;
    }

    try {
      await maybePayPot(coin, now);
    } catch (e) {
      if (e instanceof SpendCap) throw e;
      console.log(`pot check failed for ${coin}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}`);
    }

    // Keep the quote walls hugging the price.
    try {
      const listing = await factoryListings.listings(coin);
      await maybeRecenter(coin, listing.poolId, head, now);
    } catch (e) {
      console.log(`recenter check failed for ${coin}: ${String(e?.message ?? e).slice(0, 120)}`);
    }

    const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
    const holders = await holdersOf(coin, head);
    const due = [];
    const agentPaid = [];
    for (const h of holders) {
      try {
        if ((await token.pendingRewards(h)) < minDeliver) continue;
        // Holders who picked a payout through VenturePayouts get it converted;
        // a plain claimFor would hand them the raw WETH instead.
        if (payouts && (await token.payoutAgent(h)).toLowerCase() === payouts.target.toLowerCase() && (await token.atAgentTier(h))) {
          agentPaid.push(h);
        } else {
          due.push(h);
        }
      } catch { /* skip */ }
    }
    for (const h of agentPaid) {
      try { await collectPayout(coin, h); } catch (e) {
        if (e instanceof SpendCap) throw e;
        console.log(`payout for ${h} on ${coin} failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 120)}`);
      }
    }
    if (due.length === 0) return;
    console.log(`deliver dividends on ${coin}: ${due.length} holder(s)`);
    for (let j = 0; j < due.length; j += 100) {
      const batch = due.slice(j, j + 100);
      const rc = await send(`claimForMany ${coin}`, () => token.claimForMany(batch, { gasLimit: batchGas(150_000n, batch.length) }));
      const paid = countEvents(rc, coin, REWARDS_CLAIMED);
      if (paid < batch.length) console.log(`  delivered ${paid}/${batch.length}`);
      stats.delivered += paid;
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
