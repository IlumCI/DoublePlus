// The venture ops keeper's run, shared by the Node entry (venture-ops.mjs)
// and the Cloudflare Worker (worker.mjs). Everything a run touches is built
// inside runOps, so a warm Worker isolate starts each run from zero.
import { ethers } from "ethers";
import { verifyCoins } from "./sourcify.mjs";

export class SpendCap extends Error {}

/** One keeper pass. cfg is readConfig()'s result, dep the deployment JSON.
 *  Throws if the RPC serves a different chain than dep; otherwise returns
 *  the run's summary, whose solvency.ok is false if the factory owes more
 *  than it holds (null if the history could not be read to tell).
 *
 *  memory carries what one run leaves the next (the Worker keeps it in its
 *  Durable Object): spentTodayWei in (what earlier runs spent in the last
 *  24h), backoff in and out (what failed and when to try it again), index in
 *  and out (the event history the keeper has read, see syncIndex) with
 *  indexDirty naming the parts this run changed, deadlineMs in (when the run
 *  must wrap up), sourcify in and out (which coins Sourcify has verified),
 *  and spentWei out, kept current after every tx so a run that throws still
 *  reports what it spent. tokenSource is token-source.json, or null to skip
 *  source verification. */
export async function runOps({ cfg, dep, depPath, memory = {}, tokenSource = null }) {
  const { DRY_RUN, envEth, envInt, envWei, KEY, RPC } = cfg;
  const MIN_DELIVER = envWei("MIN_DELIVER", 1_000_000_000_000n);
  const RECENTER_SPACINGS = envInt("RECENTER_SPACINGS", 10, 1, 10_000);
  const SPACING = 60; // the factory's pools all use tickSpacing 60
  const CONFIRMATIONS = envInt("CONFIRMATIONS", 3, 0, 64);
  const MAX_SPEND_WEI = envEth("MAX_SPEND_ETH", "0.01");
  // Runs every minute would make the per-run cap worth 14 ETH a day. Only the
  // Worker knows what earlier runs spent; the Node entry is the manual
  // fallback, one run at a time, under the per-run cap alone.
  const MAX_DAILY_SPEND_WEI = envEth("MAX_DAILY_SPEND_ETH", "0.02");
  const dayLeft = MAX_DAILY_SPEND_WEI - (memory.spentTodayWei ?? 0n);
  const runCap = dayLeft < MAX_SPEND_WEI ? dayLeft : MAX_SPEND_WEI;
  // Blocks of history one run may index (the rest waits for the next run), so
  // catching up after a deploy is spread over runs instead of stalling one.
  const SYNC_MAX_BLOCKS = envInt("SYNC_MAX_BLOCKS", 1_000_000_000, 1, 1_000_000_000);
  // The Worker's lease outlives a run by a margin; past the deadline a run
  // starts nothing new, so the lease never expires under a run still going.
  const deadlineMs = memory.deadlineMs ?? Infinity;
  const pastDeadline = () => Date.now() > deadlineMs;
  const DELIVER_GAS_MULT = BigInt(envInt("DELIVER_GAS_MULT", 4, 1, 1000));
  // Gas one holder adds to a claimForMany batch, measured on testnet, with room.
  const GAS_PER_DELIVERY = 60_000n;

  // Every tx goes through send(): it counts what the run has spent and refuses
  // to go past runCap, so spam can cost a run (and a day) at most that much.
  const stats = { stoppedAtDeadline: false, payoutsConverted: 0, limitFilled: 0, sent: 0, spentWei: 0n, graduated: 0, aborted: 0, skippedEmptyAborts: 0, refunded: 0, delivered: 0, recentered: 0, potsPaid: 0, stoppedAtCap: false, failed: 0 };
  async function send(label, fn) {
    if (DRY_RUN) return;
    if (stats.spentWei >= runCap) { stats.stoppedAtCap = true; throw new SpendCap(label); }
    const cost = (rc) => (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? rc?.effectiveGasPrice ?? 0n);
    let rc;
    try {
      rc = await (await fn()).wait();
    } catch (e) {
      // A reverted tx still burned gas: count it, or anyone whose order or
      // payout reverts on chain (after passing the simulation) could drain the
      // keeper a run at a time without ever reaching the cap.
      if (e?.receipt) { stats.sent++; stats.spentWei += cost(e.receipt); memory.spentWei = stats.spentWei; }
      throw e;
    }
    stats.sent++;
    stats.spentWei += cost(rc);
    memory.spentWei = stats.spentWei;
    return rc;
  }

  // Anything that failed on chain, or was sent and still isn't done, waits
  // before it's tried again: 10 minutes, doubling up to a day. Without this a
  // refund to a contract that rejects ETH, or an order that passes simulation
  // and reverts on chain, would cost gas every minute until the wallet ran dry.
  const backoff = memory.backoff ?? (memory.backoff = {});
  const clock = () => Math.floor(Date.now() / 1000);
  for (const [k, v] of Object.entries(backoff)) if (v.until < clock() - 7 * 86_400) delete backoff[k];
  const waiting = (key) => (backoff[key]?.until ?? 0) > clock();
  const failed = (key) => {
    if (DRY_RUN) return;
    const n = (backoff[key]?.n ?? 0) + 1;
    backoff[key] = { n, until: clock() + Math.min(600 * 2 ** (n - 1), 86_400) };
  };
  const cleared = (key) => { delete backoff[key]; };

  /** send() for one keyed action: skipped while it waits, back on the wait
   *  list if it fails. Returns false when skipped. */
  async function attempt(key, label, fn) {
    if (waiting(key)) return false;
    try {
      const rc = await send(label, fn);
      cleared(key);
      return rc ?? true;
    } catch (e) {
      if (!(e instanceof SpendCap)) failed(key);
      throw e;
    }
  }

  /** send() for a batch: afterwards, whoever it didn't reach waits. */
  async function sendBatch(label, items, keyOf, fn, stillDue) {
    let rc;
    try {
      rc = await send(label, fn);
    } catch (e) {
      if (!(e instanceof SpendCap)) for (const it of items) failed(keyOf(it));
      throw e;
    }
    if (!DRY_RUN) for (const it of items) ((await stillDue(it).catch(() => true)) ? failed : cleared)(keyOf(it));
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

  // RPC_URL may list backups after the primary. The primary serves every
  // call; a call it keeps failing on transiently is tried once on each
  // backup before the run gives up on it. Backups may refuse the long log
  // ranges the primary allows, so they only ever step in.
  // A run starts on the first endpoint that answers, so a dead primary costs
  // one probe instead of the run (ethers' own network check bypasses send).
  const urls = RPC.split(",").map((u) => u.trim()).filter(Boolean);
  const answers = (u) => fetch(u, {
    method: "POST", headers: { "content-type": "application/json" },
    body: '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}', signal: AbortSignal.timeout(5_000),
  }).then((r) => r.json()).then((j) => Number(j.result) === Number(dep.chainId)).catch(() => false);
  let first = 0;
  while (first < urls.length - 1 && !(await answers(urls[first]))) first++;
  if (first > 0) console.log(`RPC ${urls[0]} not answering; starting on ${urls[first]}`);
  const [primaryUrl, ...backupUrls] = [urls[first], ...urls.filter((_, i) => i !== first)];
  // The backups serve logs 2k blocks at a time at best (Daybreak), so a run
  // that started on one reads history in small windows: slow, but it runs.
  const LOG_CHUNK = first > 0 ? Math.min(cfg.LOG_CHUNK, 2_000) : cfg.LOG_CHUNK;
  // The chain was just checked by the probe (and again in main), so the
  // providers skip their own detection: a backup would otherwise poll its
  // chain id all run long, logging every failure.
  // Each request gives up after 20s (ethers waits 5 minutes by default) and
  // retries a 429 once, so a throttled or hung endpoint is handed to the
  // rotation below in seconds rather than holding the run.
  const net = ethers.Network.from(Number(dep.chainId));
  const rpc = (u) => {
    const r = new ethers.FetchRequest(u);
    r.timeout = 20_000;
    r.setThrottleParams({ maxAttempts: 2 });
    return new ethers.JsonRpcProvider(r, net, { staticNetwork: net });
  };
  const provider = rpc(primaryUrl);
  const backupProviders = backupUrls.map(rpc);
  {
    const origSend = provider.send.bind(provider);
    const backups = backupProviders.map((p) => p.send.bind(p));
    const tries = backups.length ? 3 : 6;
    let reported = false;
    provider.send = async (method, params) => {
      let last;
      for (let i = 0; i < tries; i++) {
        try { return await origSend(method, params); }
        catch (e) {
          const msg = String(e?.message ?? e);
          // Throttling, overload, or the endpoint unreachable: worth another try.
          const transient = /rate|limit|429|timeout|ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|fetch failed|network|socket|SERVER_ERROR|50[0234]/i.test(msg + (e?.code ?? ""));
          if (!transient) throw e;
          last = e;
          if (i < tries - 1) await new Promise((r) => setTimeout(r, 500 * 2 ** i));
        }
      }
      if (!reported) {
        reported = true;
        console.log(`RPC ${primaryUrl} failing on ${method}: ${String(last?.shortMessage ?? last?.message ?? last).slice(0, 160)}; trying backups`);
      }
      for (const send of backups) {
        try { return await send(method, params); } catch (e) { last = e; }
      }
      throw last;
    };
  }
  const wallet = new ethers.Wallet(KEY, provider);
  const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, wallet);
  const factoryListings = new ethers.Contract(dep.contracts.factory, LISTINGS_ABI, wallet);
  const hook = new ethers.Contract(dep.contracts.hook, HOOK_ABI, wallet);
  const payouts = dep.contracts.payouts ? new ethers.Contract(dep.contracts.payouts, PAYOUTS_ABI, wallet) : null;
  const limitOrders = dep.contracts.limitOrders ? new ethers.Contract(dep.contracts.limitOrders, LIMIT_ABI, wallet) : null;

  // The event history the keeper acts on: each coin's holder balances (from
  // Transfer) and curve backers (CurveBuy), each pool's quote-wall bands
  // (LiquidityAdded/WallRemoved), and the fees the factory has credited and
  // paid out. Read forward from the last block indexed instead of from the
  // deploy block every run: a run reads about a minute of blocks.
  const index = memory.index ?? (memory.index = { meta: null, coins: {}, bands: {} });
  const dirty = memory.indexDirty ?? (memory.indexDirty = new Set());
  index.meta ??= { cursor: Number(dep.startBlock ?? 0) - 1, accrued: "0", withdrawn: "0" };
  const coinIndex = (coin) => (index.coins[coin.toLowerCase()] ??= { bal: {}, backers: {} });

  async function syncIndex(head, coins) {
    const t = (c, ev) => c.interface.getEvent(ev).topicHash;
    const T = {
      buy: t(factory, "CurveBuy"), accrued: t(factory, "FeeAccrued"), withdrawn: t(factory, "FeesWithdrawn"),
      add: t(hook, "LiquidityAdded"), remove: t(hook, "WallRemoved"),
    };
    const groups = [];
    for (let i = 0; i < coins.length; i += 50) groups.push(coins.slice(i, i + 50));
    const stop = Math.min(head, index.meta.cursor + SYNC_MAX_BLOCKS);
    for (let a = index.meta.cursor + 1; a <= stop && !pastDeadline(); a += LOG_CHUNK) {
      const b = Math.min(a + LOG_CHUNK - 1, stop);
      // One topic per query (the RPC limits OR-lists), every query for the
      // range answered before any is applied, so a failed range is redone whole.
      const q = (address, topic) => provider.getLogs({ address, topics: [topic], fromBlock: a, toBlock: b });
      const [buys, accrued, withdrawn, adds, removes, ...transfers] = await Promise.all([
        q(dep.contracts.factory, T.buy), q(dep.contracts.factory, T.accrued), q(dep.contracts.factory, T.withdrawn),
        q(dep.contracts.hook, T.add), q(dep.contracts.hook, T.remove),
        ...groups.map((g) => q(g, TRANSFER_TOPIC)),
      ]);
      for (const l of buys) {
        const { token, buyer } = factory.interface.parseLog(l).args;
        coinIndex(token).backers[buyer] = 1;
        dirty.add(`coin:${token.toLowerCase()}`);
      }
      let acc = BigInt(index.meta.accrued), wd = BigInt(index.meta.withdrawn);
      for (const l of accrued) acc += BigInt(factory.interface.parseLog(l).args.amount);
      for (const l of withdrawn) wd += BigInt(factory.interface.parseLog(l).args.amount);
      index.meta.accrued = acc.toString();
      index.meta.withdrawn = wd.toString();
      for (const [logs, sign] of [[adds, 1n], [removes, -1n]]) {
        for (const l of logs) {
          const e = hook.interface.parseLog(l).args;
          if (sign === 1n && !e.wall) continue;
          const id = e.id.toLowerCase(), k = `${e.tickLower}:${e.tickUpper}`;
          const bands = (index.bands[id] ??= {});
          const liq = BigInt(bands[k] ?? 0) + sign * BigInt(e.liquidity);
          if (liq > 0n) bands[k] = liq.toString(); else delete bands[k];
          dirty.add(`bands:${id}`);
        }
      }
      for (const l of transfers.flat()) {
        const v = BigInt(l.data);
        if (v === 0n) continue;
        const bal = coinIndex(l.address).bal;
        const move = (who, d) => {
          const n = BigInt(bal[who] ?? 0) + d;
          if (n > 0n) bal[who] = n.toString(); else delete bal[who];
        };
        move(ethers.getAddress("0x" + l.topics[1].slice(26)), -v);
        move(ethers.getAddress("0x" + l.topics[2].slice(26)), v);
        dirty.add(`coin:${l.address.toLowerCase()}`);
      }
      index.meta.cursor = b;
      dirty.add("meta");
    }
  }

  /** Fill whatever open limit orders the pools can meet right now. A fill that
   *  would miss the owner's price reverts in simulation and is skipped. */
  async function fillLimitOrders() {
    if (!limitOrders) return;
    const total = Number(await limitOrders.totalOrders());
    for (let id = 0; id < total; id++) {
      if (waiting(`fill:${id}`)) continue;
      const o = await limitOrders.order(id);
      if (o.amountIn === 0n) continue;
      try {
        await limitOrders.fill.staticCall(id, { gasLimit: FILL_GAS });
      } catch { continue; } // not fillable yet
      console.log(`fill limit order ${id} (${o.isBuy ? "buy" : "sell"} ${o.coin})`);
      // One order failing on chain must not stop the orders after it.
      try {
        await attempt(`fill:${id}`, `fill ${id}`, () => limitOrders.fill(id, { gasLimit: FILL_GAS }));
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
    if (await attempt(`collect:${coin}:${holder}`, `collect ${coin} ${holder}`, () => payouts.collect(coin, holder, minOut, { gasLimit: COLLECT_GAS }))) stats.payoutsConverted++;
  }

  /** Live wall set for a pool: LiquidityAdded(wall) minus WallRemoved, netted
   *  per (lower, upper) band, from the index. */
  function wallBands(poolId) {
    return Object.entries(index.bands[poolId.toLowerCase()] ?? {}).map(([k, liquidity]) => {
      const [lower, upper] = k.split(":").map(Number);
      return { lower, upper, liquidity: BigInt(liquidity) };
    });
  }

  /** Migrate stale quote walls back beside the price when they have drifted. */
  async function maybeRecenter(coin, poolId, now) {
    const bands = wallBands(poolId);
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
    const key = `recenter:${coin}`;
    if (waiting(key)) return;
    try { await hook.recenter.staticCall(coin, bands); } catch { failed(key); return; }
    console.log(`recenter ${coin}: ${bands.length} wall band(s), tick ${tick}`);
    if (await attempt(key, `recenter ${coin}`, () => hook.recenter(coin, bands))) stats.recentered++;
  }

  /** Push refunds for an aborted raise to every backer the contract would pay:
   *  ETH still escrowed for them, everything they bought still in their wallet,
   *  and worth more than the gas to send it. */
  async function pushRefunds(coin, minDeliver) {
    const backers = Object.keys(coinIndex(coin).backers);
    const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
    const due = [];
    for (const b of backers) {
      const [spent, bought, held] = await Promise.all([factory.spentWei(coin, b), factory.boughtTokens(coin, b), token.balanceOf(b)]);
      if (spent >= minDeliver && held >= bought && !waiting(`refund:${coin}:${b}`)) due.push(b);
    }
    if (due.length === 0) return;
    console.log(`push refunds on ${coin}: ${due.length} backer(s)`);
    for (let j = 0; j < due.length; j += 100) {
      const batch = due.slice(j, j + 100);
      const rc = await sendBatch(`refundMany ${coin}`, batch, (b) => `refund:${coin}:${b}`,
      () => factory.refundMany(coin, batch, { gasLimit: batchGas(120_000n, batch.length) }),
      async (b) => (await factory.spentWei(coin, b)) > 0n);
      const paid = countEvents(rc, factory.target, REFUNDED);
      if (paid < batch.length) console.log(`  refunded ${paid}/${batch.length}; the rest can still claim on the site`);
      stats.refunded += paid;
    }
  }

  /** Pay a pot whose clock ran out with no trade since to take it. */
  async function maybePayPot(coin, now) {
    const p = await hook.pot(coin);
    if (p.leader === ZERO || now < Number(p.deadline)) return;
    const key = `pot:${coin}`;
    if (waiting(key)) return;
    try { await hook.claimPot.staticCall(coin); } catch { failed(key); return; }
    console.log(`pay pot on ${coin} to ${p.leader}`);
    if (await attempt(key, `claimPot ${coin}`, () => hook.claimPot(coin))) stats.potsPaid++;
  }

  function holdersOf(coin) {
    const balances = Object.entries(coinIndex(coin).bal);
    const system = new Set(
      // The order book and payout router only hold coins in passing; pushing
      // rewards to them would strand WETH they have no way to pass on.
      [ZERO, DEAD, dep.contracts.poolManager, dep.contracts.factory, dep.contracts.router, dep.contracts.hook, coin,
        dep.contracts.limitOrders ?? ZERO, dep.contracts.payouts ?? ZERO]
        .map((a) => a.toLowerCase()),
    );
    return balances
      .filter(([a, b]) => BigInt(b) > 0n && !system.has(a.toLowerCase()))
      .map(([a]) => a);
  }

  async function main() {
    // The deployment file and the RPC must describe the same chain. Without this
    // a mainnet RPC with testnet addresses reads zeroes from contracts that do
    // not exist there, and the keeper reports "0 ventures" and exits clean —
    // looking healthy while doing nothing.
    const net = await provider.getNetwork();
    if (Number(net.chainId) !== Number(dep.chainId)) {
      throw new Error(
        `chain mismatch: RPC is ${net.chainId}, ${depPath} is for ${dep.chainId}. ` +
        `Set CHAIN_ID=${net.chainId} (or DEPLOYMENT_FILE) to match RPC_URL.`,
      );
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

    const coins = await Promise.all(Array.from({ length: total }, (_, i) => factory.allTokens(i)));
    try {
      await syncIndex(head, coins);
    } catch (e) {
      // The coins below still run, on what has been indexed so far.
      console.log(`index sync stopped at block ${index.meta.cursor}: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
    for (const coin of coins) {
      if (pastDeadline()) { stats.stoppedAtDeadline = true; break; }
      try {
        await processCoin(coin, now, minDeliver);
      } catch (e) {
        if (e instanceof SpendCap) { console.log(`spend cap reached at ${e.message}; stopping this run`); break; }
        // One coin failing must not stop the rest: a single hostile or broken
        // coin would otherwise block refunds and payouts for every later one.
        stats.failed++;
        console.log(`coin ${coin} failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
      }
    }
    try {
      if (!pastDeadline()) await fillLimitOrders();
    } catch (e) {
      if (!(e instanceof SpendCap)) console.log(`limit orders failed: ${String(e?.shortMessage ?? e?.message ?? e).slice(0, 160)}`);
    }
    // Source verification for new coins (see sourcify.mjs), kept in
    // memory.sourcify between runs; a run without memory checks them afresh.
    if (tokenSource && !pastDeadline()) {
      stats.sourcified = await verifyCoins({ coins, chainId: Number(dep.chainId), source: tokenSource,
        state: memory.sourcify ?? (memory.sourcify = {}), pastDeadline }).catch(() => 0);
    }
    // Unknown (ok: null) when the history can't be read, e.g. on a backup RPC
    // that refuses the range; only a shortfall actually seen fails the run.
    const solvency = await checkSolvency(coins, head).catch((e) => ({ ok: null, error: String(e?.shortMessage ?? e?.message ?? e).slice(0, 160) }));
    const summary = { keeper: "venture-ops", indexedTo: index.meta.cursor, waiting: Object.keys(backoff).length, runCapWei: runCap.toString(), solvency, chain: Number(dep.chainId), ventures: total, ...stats, spentWei: stats.spentWei.toString(), minDeliver: minDeliver.toString(), balanceWei: balance.toString() };
    console.log(JSON.stringify(summary));
    return summary;
  }

  /**
   * The factory must always hold at least what it owes: the ETH escrowed in
   * every raise that hasn't graduated or been swept, plus every fee credited
   * and not yet withdrawn (reconstructed from FeeAccrued and FeesWithdrawn).
   * A shortfall means a bug or an exploit; the run then reports solvency.ok
   * false, and each entry turns that into a failed run.
   */
  async function checkSolvency(coins, head) {
    // Fees owed come from the index, so they only add up once it has reached
    // the head: until then a withdrawal it hasn't read yet would look like a
    // shortfall.
    if (index.meta.cursor < head) return { ok: null, error: `index catching up: block ${index.meta.cursor} of ${head}` };
    let escrow = 0n;
    for (const coin of coins) {
      const [st, t] = await Promise.all([factory.curveState(coin, { blockTag: head }), factory.terms(coin, { blockTag: head })]);
      if (!st.finalized && !t.swept) escrow += st.raisedWei;
    }
    const accrued = BigInt(index.meta.accrued), withdrawn = BigInt(index.meta.withdrawn);
    const owed = escrow + (accrued - withdrawn);
    const balance = await provider.getBalance(dep.contracts.factory, head);
    const ok = balance >= owed;
    if (!ok) {
      console.error(`CRITICAL factory insolvent: holds ${ethers.formatEther(balance)} ETH, owes ${ethers.formatEther(owed)} (escrow ${ethers.formatEther(escrow)}, fees ${ethers.formatEther(accrued - withdrawn)})`);
    }
    return { ok, balanceWei: balance.toString(), owedWei: owed.toString(), escrowWei: escrow.toString(), feesOwedWei: (accrued - withdrawn).toString() };
  }

  async function processCoin(coin, now, minDeliver) {
    {
      const st = await factory.curveState(coin);

      if (!st.finalized && !st.aborted) {
        const targetHit = st.raisedWei >= st.targetRaiseWei || st.remainingWhole === 0n;
        if (targetHit) {
          if (waiting(`finalize:${coin}`)) return;
          console.log(`graduate ${coin} (raised ${ethers.formatEther(st.raisedWei)} ETH)`);
          if (await attempt(`finalize:${coin}`, `finalize ${coin}`, () => factory.finalize(coin))) stats.graduated++;
        } else if (now >= Number(st.deadline)) {
          // Nobody's money is in a raise that raised nothing, so there is no
          // refund to open. Aborting it would only spend gas, which is exactly
          // what a flood of dead launches is for.
          if (st.raisedWei === 0n) { stats.skippedEmptyAborts++; return; }
          if (waiting(`abort:${coin}`)) return;
          console.log(`abort ${coin} (deadline passed at ${ethers.formatEther(st.raisedWei)}/${ethers.formatEther(st.targetRaiseWei)} ETH)`);
          if (!(await attempt(`abort:${coin}`, `abort ${coin}`, () => factory.abort(coin)))) return;
          stats.aborted++;
          if (!DRY_RUN) await pushRefunds(coin, minDeliver);
        }
        return; // dividends only exist after graduation
      }
      if (!st.finalized) {
        // Aborted: refunds go out until the escrow is swept.
        if (!(await factory.terms(coin)).swept) await pushRefunds(coin, minDeliver);
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
        await maybeRecenter(coin, listing.poolId, now);
      } catch (e) {
        console.log(`recenter check failed for ${coin}: ${String(e?.message ?? e).slice(0, 120)}`);
      }

      const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
      const holders = holdersOf(coin);
      const due = [];
      const agentPaid = [];
      for (const h of holders) {
        try {
          if (waiting(`deliver:${coin}:${h}`) || (await token.pendingRewards(h)) < minDeliver) continue;
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
        const rc = await sendBatch(`claimForMany ${coin}`, batch, (h) => `deliver:${coin}:${h}`,
      () => token.claimForMany(batch, { gasLimit: batchGas(150_000n, batch.length) }),
      async (h) => (await token.pendingRewards(h)) >= minDeliver);
        const paid = countEvents(rc, coin, REWARDS_CLAIMED);
        if (paid < batch.length) console.log(`  delivered ${paid}/${batch.length}`);
        stats.delivered += paid;
      }
    }
  }

  // Providers keep polling (and retrying an unreachable endpoint) until
  // destroyed, which would hold a Node run open after it finished.
  try {
    return await main();
  } finally {
    for (const p of [provider, ...backupProviders]) p.destroy();
  }
}
