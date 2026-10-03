// doubleplus weekly jackpot flywheel.
//
// Each epoch (one run = one epoch, scheduled weekly):
//   1) read the epoch's Routed events from the VentureRouter — ETH-denominated
//      volume per venture and per trader;
//   2) size the jackpot: the protocol's estimated epoch revenue in ETH
//      (volume x platformFeeBps) x JACKPOT_BPS, capped by the keeper wallet;
//   3) spend it three ways (each capped by WASH_CAP_BPS below) — 40% market-buys the top-3 ventures by volume
//      (weighted 50/30/20) and burns the tokens to dEaD; 30% pays ETH rebates
//      to the top-10 traders pro-rata by volume; 30% pays OUTSIDE makers who
//      added liquidity to venture pools during the epoch (attributed to the
//      transaction sender of each ModifyLiquidity, protocol addresses
//      excluded; rolls into the burn pot when the epoch had no outside
//      makers);
//   4) publish a manifest to web/public/rewards/venture/epoch-<n>.json and
//      advance the cursor in index.json.
//
// Payouts are journaled. Before the first transaction the whole plan (block
// range, every recipient and amount) is written to epoch-<n>.pending.json, and
// each transaction hash is recorded the moment it is sent. A run that dies
// halfway leaves that journal behind (the workflow commits it even on
// failure); the next run resumes the same plan and skips everything already
// paid, instead of recomputing the epoch and paying it twice.
//
// v1 honesty note: execution is treasury-side policy, transparent through the
// manifests and on-chain txs, not yet contract-enforced.
//
// Env:
//   KEEPER_PRIVATE_KEY  (required) the treasury/keeper wallet (funds the jackpot)
//   RPC_URL             (default https://rpc.testnet.chain.robinhood.com)
//   CHAIN_ID            (default 46630) picks the deployment file: 4663 ->
//                       venture-robinhood.json, 46630 -> venture-testnet.json.
//                       Must agree with RPC_URL or the run aborts.
//   DEPLOYMENT_FILE     explicit override for the above
//   JACKPOT_BPS         (default 2500) share of estimated epoch revenue to spend
//   MAX_JACKPOT_ETH     (default 0.5) hard cap per epoch
//   BUYBACK_SLIPPAGE_BPS (default 300) floor on buyback output vs a simulation
//                       taken just before sending
//   MAKER_REWARDS       (default off) pay the outside-maker share. Off because
//                       it counts liquidity *added*, which add/remove cycling
//                       farms for gas alone, and liquidity units aren't
//                       comparable across pools. Off, that share buys back.
//   WASH_CAP_BPS        (default 5000) no trader is rebated, and no coin bought
//                       back, more than this share of the platform fees its own
//                       volume paid (net of the referee discount and referral
//                       share). Wash trading then always costs more than it
//                       earns; the unspent budget stays in the treasury.
//   LOG_CHUNK           (default 500000)
//   DRY_RUN             set to print the plan to epoch-<n>.dryrun.json without
//                       sending txs or advancing the cursor
import { ethers } from "ethers";
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const DEPLOYMENTS = {
  4663: "venture-robinhood.json",
  46630: "venture-testnet.json",
};
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 46630);
const depPath = process.env.DEPLOYMENT_FILE
  ?? join(here, "../contracts/deployments", DEPLOYMENTS[CHAIN_ID] ?? "venture-testnet.json");
const dep = JSON.parse(readFileSync(depPath, "utf8"));
const MANIFEST_DIR = join(here, "../web/public/rewards/venture");

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const KEY = process.env.KEEPER_PRIVATE_KEY;
if (!KEY) { console.error("Set KEEPER_PRIVATE_KEY."); process.exit(1); }
const JACKPOT_BPS = Number(process.env.JACKPOT_BPS ?? 2500);
const MAX_JACKPOT_ETH = ethers.parseEther(process.env.MAX_JACKPOT_ETH ?? "0.5");
const MAKER_REWARDS = (process.env.MAKER_REWARDS ?? "off") === "on";
const WASH_CAP_BPS = BigInt(process.env.WASH_CAP_BPS ?? 5000);
const SLIPPAGE_BPS = BigInt(process.env.BUYBACK_SLIPPAGE_BPS ?? 300);
const LOG_CHUNK = Number(process.env.LOG_CHUNK ?? "500000");
const DRY_RUN = process.env.DRY_RUN != null;
const DEAD = "0x000000000000000000000000000000000000dEaD";

const ROUTER_ABI = [
  "event Routed(address indexed trader, address indexed coin, bool isBuy, uint256 ethIn, uint256 ethOut)",
  "function buy(address coin, bytes v3Path, uint256 minCoinOut) payable returns (uint256)",
];
const ERC20_ABI = [
  "event Transfer(address indexed from, address indexed to, uint256 value)",
  "function transfer(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];
const FACTORY_ABI = [
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
];
const PM_ABI = [
  "event ModifyLiquidity(bytes32 indexed id, address indexed sender, int24 tickLower, int24 tickUpper, int256 liquidityDelta, bytes32 salt)",
];

const provider = new ethers.JsonRpcProvider(RPC);
{
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    for (let i = 0; ; i++) {
      try { return await origSend(method, params); }
      catch (e) {
        const transient = /rate|limit|429|timeout|ETIMEDOUT|ECONNRESET|503|502/i.test(String(e?.message ?? e));
        if (!transient || i >= 5) throw e;
        await new Promise((r) => setTimeout(r, 500 * 2 ** i));
      }
    }
  };
}
const wallet = new ethers.Wallet(KEY, provider);
const router = new ethers.Contract(dep.contracts.router, ROUTER_ABI, wallet);
const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, wallet);

/**
 * eth_getLogs over [from, to] in LOG_CHUNK windows, halving any window the RPC
 * refuses for returning too many logs (busy chains hit the 10k-log cap).
 */
async function getLogs(filter, from, to) {
  const out = [];
  const pull = async (a, b) => {
    try {
      out.push(...(await provider.getLogs({ ...filter, fromBlock: a, toBlock: b })));
    } catch (e) {
      if (a === b || !/exceeds limit|too many|response size|range/i.test(String(e?.error?.message ?? e?.message ?? e))) throw e;
      const mid = a + Math.floor((b - a) / 2);
      await pull(a, mid);
      await pull(mid + 1, b);
    }
  };
  for (let s = from; s <= to; s += LOG_CHUNK) await pull(s, Math.min(s + LOG_CHUNK - 1, to));
  return out;
}

const write = (path, obj) => writeFileSync(path, JSON.stringify(obj, null, 2));

async function main() {
  // Same guard as venture-ops: a mainnet RPC with testnet addresses would read
  // an empty epoch and advance the cursor past real volume.
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(dep.chainId)) {
    console.error(
      `chain mismatch: RPC is ${net.chainId}, ${depPath} is for ${dep.chainId}.\n` +
      `Set CHAIN_ID=${net.chainId} (or DEPLOYMENT_FILE) to match RPC_URL.`,
    );
    process.exit(1);
  }

  mkdirSync(MANIFEST_DIR, { recursive: true });
  const indexPath = join(MANIFEST_DIR, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { epoch: 0, lastBlock: Number(dep.startBlock ?? 0) };
  const epoch = index.epoch + 1;
  const pendingPath = join(MANIFEST_DIR, `epoch-${epoch}.pending.json`);

  let plan;
  if (existsSync(pendingPath)) {
    plan = JSON.parse(readFileSync(pendingPath, "utf8"));
    console.log(`flywheel epoch ${epoch}: resuming the journaled plan for blocks ${plan.fromBlock}..${plan.toBlock}`);
  } else {
    plan = await buildPlan(epoch, index.lastBlock + 1, await provider.getBlockNumber());
    if (!plan) {
      console.log("no routed volume this epoch; advancing cursor only");
      if (!DRY_RUN) write(indexPath, { epoch, lastBlock: (await provider.getBlockNumber()) });
      return;
    }
    if (DRY_RUN) {
      write(join(MANIFEST_DIR, `epoch-${epoch}.dryrun.json`), { ...plan, dryRun: true });
      console.log(`[DRY_RUN] plan written to epoch-${epoch}.dryrun.json; cursor not advanced`);
      return;
    }
    write(pendingPath, plan);
  }

  await execute(plan, () => write(pendingPath, plan));

  const { toBlock } = plan;
  write(join(MANIFEST_DIR, `epoch-${epoch}.json`), { ...plan, dryRun: false, generatedAt: new Date().toISOString() });
  write(indexPath, { epoch, lastBlock: toBlock });
  unlinkSync(pendingPath);
  console.log(`epoch ${epoch} published: ${plan.ventures.length} burns, ${plan.rebates.length} rebates, ${plan.makers.length} maker rewards`);
}

/** Read the epoch and size every payout. Sends nothing. Null when the epoch had no volume. */
async function buildPlan(epoch, fromBlock, toBlock) {
  console.log(`flywheel epoch ${epoch}: blocks ${fromBlock}..${toBlock}${DRY_RUN ? " [DRY_RUN]" : ""}`);

  // 1) Epoch volume from Routed events, in ETH terms.
  const byCoin = new Map();
  const byTrader = new Map();
  const topic = router.interface.getEvent("Routed").topicHash;
  for (const l of await getLogs({ address: dep.contracts.router, topics: [topic] }, fromBlock, toBlock)) {
    const { trader, coin, ethIn, ethOut } = router.interface.parseLog(l).args;
    const v = BigInt(ethIn) + BigInt(ethOut);
    byCoin.set(coin, (byCoin.get(coin) ?? 0n) + v);
    byTrader.set(trader, (byTrader.get(trader) ?? 0n) + v);
  }
  const totalVolume = [...byCoin.values()].reduce((a, b) => a + b, 0n);
  if (totalVolume === 0n) return null;

  // 2) Jackpot budget: estimated protocol revenue x JACKPOT_BPS, capped.
  const revenueEst = (totalVolume * BigInt(dep.platformFeeBps ?? 100)) / 10_000n;
  let budget = (revenueEst * BigInt(JACKPOT_BPS)) / 10_000n;
  if (budget > MAX_JACKPOT_ETH) budget = MAX_JACKPOT_ETH;
  const balance = await provider.getBalance(wallet.address);
  if (budget > balance / 2n) budget = balance / 2n; // never drain the keeper
  console.log(`volume ${ethers.formatEther(totalVolume)} ETH, jackpot ${ethers.formatEther(budget)} ETH`);

  // 2b) Outside-maker volume: positive liquidity adds on venture pools this
  // epoch, attributed to the transaction sender, protocol addresses excluded.
  const pm = new ethers.Contract(dep.contracts.poolManager, PM_ABI, provider);
  const poolIds = new Set();
  const totalCoins = Number(await factory.totalTokens());
  for (let i = 0; i < totalCoins; i++) {
    const l = await factory.listings(await factory.allTokens(i));
    if (l.poolId !== ethers.ZeroHash) poolIds.add(l.poolId.toLowerCase());
  }
  const protocolAddrs = new Set(
    [dep.contracts.hook, dep.contracts.factory, dep.contracts.router, wallet.address].map((a) => a.toLowerCase()),
  );
  const byMaker = new Map();
  if (MAKER_REWARDS) {
  const mlTopic = pm.interface.getEvent("ModifyLiquidity").topicHash;
  // The PoolManager is shared by every pool on the chain: filter to ours in the
  // query (poolId is the first indexed topic) rather than after fetching.
  const mlLogs = poolIds.size === 0 ? [] : await getLogs(
    { address: dep.contracts.poolManager, topics: [mlTopic, [...poolIds]] }, fromBlock, toBlock);
  for (const l of mlLogs) {
    const a = pm.interface.parseLog(l).args;
    const delta = BigInt(a.liquidityDelta);
    if (delta <= 0n) continue;
    if (protocolAddrs.has(String(a.sender).toLowerCase())) continue;
    const tx = await provider.getTransaction(l.transactionHash);
    const maker = tx?.from?.toLowerCase();
    if (!maker || protocolAddrs.has(maker)) continue;
    byMaker.set(maker, (byMaker.get(maker) ?? 0n) + delta);
  }
  }

  // 3a) Buyback-and-burn the top-3 ventures: 40% of the budget (plus the
  // maker share when no outside maker showed up this epoch). v1 burns only
  // WETH-paired ventures (path-free route); stock pairs are listed but skipped.
  const topCoins = [...byCoin.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
  const weights = [50, 30, 20];
  const makerBudgetPlanned = (budget * 30n) / 100n;
  const rebateBudget = (budget * 30n) / 100n;
  const burnBudget = budget - rebateBudget - (byMaker.size > 0 ? makerBudgetPlanned : 0n);
  const ventures = [];
  // The least the treasury kept from `vol` of routed volume: platform fee,
  // less the 10% referee discount, less the 20% referral share (which an
  // attacker can route to a second wallet of their own).
  const bps = BigInt(dep.platformFeeBps ?? 100);
  const netFee = (vol) => (vol * bps * 72n) / 1_000_000n;
  const washCap = (vol) => (netFee(vol) * WASH_CAP_BPS) / 10_000n;
  for (let i = 0; i < topCoins.length; i++) {
    const [coin, vol] = topCoins[i];
    let spend = (burnBudget * BigInt(weights[i])) / 100n;
    // Buying back more than the coin's own volume paid in fees would make
    // wash-trading a coin into the top three a profit.
    if (spend > washCap(vol)) spend = washCap(vol);
    const listing = await factory.listings(coin);
    const burnable = spend > 0n && listing.pair.toLowerCase() === dep.contracts.weth.toLowerCase();
    ventures.push({ coin, volumeEth: ethers.formatEther(vol), spendEth: ethers.formatEther(spend), spendWei: spend.toString(), burnable, burnedTokens: "0", buyTx: null, burnTx: null });
  }

  // 3b) ETH rebates to the top-10 traders, pro-rata by volume.
  const topTraders = [...byTrader.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 10);
  const traderVolume = topTraders.reduce((a, [, v]) => a + v, 0n);
  const rebates = topTraders.map(([trader, vol]) => {
    let amount = traderVolume === 0n ? 0n : (rebateBudget * vol) / traderVolume;
    // A rebate above the fees this trader's own volume paid would pay
    // wash trading; cap it there.
    if (amount > washCap(vol)) amount = washCap(vol);
    return { trader, volumeEth: ethers.formatEther(vol), amountEth: ethers.formatEther(amount), amountWei: amount.toString(), tx: null };
  });

  // 3c) Maker rewards: ETH pro-rata by liquidity added this epoch.
  const makerTotal = [...byMaker.values()].reduce((a, b) => a + b, 0n);
  const makers = [...byMaker.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 10).map(([maker, liq]) => {
    const amount = makerTotal === 0n ? 0n : (makerBudgetPlanned * liq) / makerTotal;
    return { maker, liquidityAdded: liq.toString(), amountEth: ethers.formatEther(amount), amountWei: amount.toString(), tx: null };
  });

  return {
    epoch, fromBlock, toBlock,
    totalVolumeEth: ethers.formatEther(totalVolume),
    budgetEth: ethers.formatEther(budget),
    ventures, rebates, makers,
    makerAttribution: "tx sender of each positive ModifyLiquidity on venture pools; protocol addresses excluded",
  };
}

/**
 * A transaction recorded in the journal by an earlier run: confirmed means skip it.
 * Anything not provably mined stops the run — resending could pay twice, and
 * a human should look at a stuck or dropped transaction first.
 */
async function alreadyDone(hash, what) {
  if (!hash) return null;
  const r = await provider.getTransactionReceipt(hash);
  if (r && r.status === 1) return r;
  throw new Error(
    `${what}: journaled tx ${hash} is ${r ? "reverted" : "not mined"}. ` +
    `Check it on the explorer; once it is final, clear that entry's hash in the pending journal to retry, or set it to the replacement's hash.`,
  );
}

/** Send, journal the hash before waiting, then wait. */
async function send(entry, key, save, txPromise) {
  const sent = await txPromise;
  entry[key] = sent.hash;
  save();
  const r = await sent.wait();
  if (r.status !== 1) throw new Error(`${key} ${sent.hash} reverted`);
  return r;
}

async function execute(plan, save) {
  for (const v of plan.ventures) {
    if (!v.burnable || v.burnTx && (await alreadyDone(v.burnTx, `burn ${v.coin}`))) continue;
    const erc = new ethers.Contract(v.coin, ERC20_ABI, wallet);
    let receipt = await alreadyDone(v.buyTx, `buyback ${v.coin}`);
    if (!receipt) {
      // Floor the output against a simulation taken now: the buy is a public
      // market order sized days in advance, an easy sandwich without one.
      const spend = BigInt(v.spendWei);
      const quoted = await router.buy.staticCall(v.coin, "0x", 0, { value: spend });
      const minOut = (quoted * (10_000n - SLIPPAGE_BPS)) / 10_000n;
      receipt = await send(v, "buyTx", save, router.buy(v.coin, "0x", minOut, { value: spend }));
    }
    // What the buy delivered, read from its own receipt so a resumed run gets the same number.
    const transferTopic = erc.interface.getEvent("Transfer").topicHash;
    const got = receipt.logs
      .filter((l) => l.address.toLowerCase() === v.coin.toLowerCase() && l.topics[0] === transferTopic)
      .map((l) => erc.interface.parseLog(l).args)
      .filter((a) => a.to.toLowerCase() === wallet.address.toLowerCase())
      .reduce((a, b) => a + BigInt(b.value), 0n);
    v.burnedTokens = got.toString();
    save();
    if (got > 0n) await send(v, "burnTx", save, erc.transfer(DEAD, got));
  }

  for (const [list, who] of [[plan.rebates, "trader"], [plan.makers, "maker"]]) {
    for (const entry of list) {
      const amount = BigInt(entry.amountWei);
      if (amount === 0n || (await alreadyDone(entry.tx, `${who} ${entry[who]}`))) continue;
      await send(entry, "tx", save, wallet.sendTransaction({ to: entry[who], value: amount }));
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
