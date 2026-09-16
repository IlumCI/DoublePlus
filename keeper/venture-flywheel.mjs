// doubleplus weekly jackpot flywheel.
//
// Each epoch (one run = one epoch, scheduled weekly):
//   1) read the epoch's Routed events from the VentureRouter — ETH-denominated
//      volume per venture and per trader;
//   2) size the jackpot: the protocol's estimated epoch revenue in ETH
//      (volume x platformFeeBps) x JACKPOT_BPS, capped by the keeper wallet;
//   3) spend it — 50% market-buys the top-3 ventures by volume (weighted
//      50/30/20) and burns the tokens to dEaD; 50% pays ETH rebates to the
//      top-10 traders pro-rata by volume;
//   4) publish a manifest to web/public/rewards/venture/epoch-<n>.json and
//      advance the cursor in index.json.
//
// v1 honesty note: execution is treasury-side policy, transparent through the
// manifests and on-chain txs, not yet contract-enforced.
//
// Env:
//   KEEPER_PRIVATE_KEY  (required) the treasury/keeper wallet (funds the jackpot)
//   RPC_URL             (default https://rpc.testnet.chain.robinhood.com)
//   DEPLOYMENT_FILE     (default ../contracts/deployments/venture-testnet.json)
//   JACKPOT_BPS         (default 2500) share of estimated epoch revenue to spend
//   MAX_JACKPOT_ETH     (default 0.5) hard cap per epoch
//   LOG_CHUNK           (default 500000)
//   DRY_RUN             set to publish a manifest without sending txs
import { ethers } from "ethers";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const depPath = process.env.DEPLOYMENT_FILE ?? join(here, "../contracts/deployments/venture-testnet.json");
const dep = JSON.parse(readFileSync(depPath, "utf8"));
const MANIFEST_DIR = join(here, "../web/public/rewards/venture");

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const KEY = process.env.KEEPER_PRIVATE_KEY;
if (!KEY) { console.error("Set KEEPER_PRIVATE_KEY."); process.exit(1); }
const JACKPOT_BPS = Number(process.env.JACKPOT_BPS ?? 2500);
const MAX_JACKPOT_ETH = ethers.parseEther(process.env.MAX_JACKPOT_ETH ?? "0.5");
const LOG_CHUNK = Number(process.env.LOG_CHUNK ?? "500000");
const DRY_RUN = process.env.DRY_RUN != null;
const DEAD = "0x000000000000000000000000000000000000dEaD";

const ROUTER_ABI = [
  "event Routed(address indexed trader, address indexed coin, bool isBuy, uint256 ethIn, uint256 ethOut)",
  "function buy(address coin, bytes v3Path, uint256 minCoinOut) payable returns (uint256)",
];
const ERC20_ABI = [
  "function transfer(address, uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function symbol() view returns (string)",
];
const FACTORY_ABI = ["function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)"];

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

async function main() {
  mkdirSync(MANIFEST_DIR, { recursive: true });
  const indexPath = join(MANIFEST_DIR, "index.json");
  const index = existsSync(indexPath) ? JSON.parse(readFileSync(indexPath, "utf8")) : { epoch: 0, lastBlock: Number(dep.startBlock ?? 0) };
  const fromBlock = index.lastBlock + 1;
  const toBlock = await provider.getBlockNumber();
  const epoch = index.epoch + 1;
  console.log(`flywheel epoch ${epoch}: blocks ${fromBlock}..${toBlock}${DRY_RUN ? " [DRY_RUN]" : ""}`);

  // 1) Epoch volume from Routed events, in ETH terms.
  const byCoin = new Map();
  const byTrader = new Map();
  const topic = router.interface.getEvent("Routed").topicHash;
  for (let s = fromBlock; s <= toBlock; s += LOG_CHUNK) {
    const e = Math.min(s + LOG_CHUNK - 1, toBlock);
    const logs = await provider.getLogs({ address: dep.contracts.router, topics: [topic], fromBlock: s, toBlock: e });
    for (const l of logs) {
      const { trader, coin, ethIn, ethOut } = router.interface.parseLog(l).args;
      const v = BigInt(ethIn) + BigInt(ethOut);
      byCoin.set(coin, (byCoin.get(coin) ?? 0n) + v);
      byTrader.set(trader, (byTrader.get(trader) ?? 0n) + v);
    }
  }
  const totalVolume = [...byCoin.values()].reduce((a, b) => a + b, 0n);
  if (totalVolume === 0n) {
    console.log("no routed volume this epoch; advancing cursor only");
    writeFileSync(indexPath, JSON.stringify({ epoch, lastBlock: toBlock }, null, 2));
    return;
  }

  // 2) Jackpot budget: estimated protocol revenue x JACKPOT_BPS, capped.
  const revenueEst = (totalVolume * BigInt(dep.platformFeeBps ?? 100)) / 10_000n;
  let budget = (revenueEst * BigInt(JACKPOT_BPS)) / 10_000n;
  if (budget > MAX_JACKPOT_ETH) budget = MAX_JACKPOT_ETH;
  const balance = await provider.getBalance(wallet.address);
  if (budget > balance / 2n) budget = balance / 2n; // never drain the keeper
  console.log(`volume ${ethers.formatEther(totalVolume)} ETH, jackpot ${ethers.formatEther(budget)} ETH`);

  // 3a) Buyback-and-burn the top-3 ventures, 50/30/20 of half the budget.
  const topCoins = [...byCoin.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 3);
  const weights = [50, 30, 20];
  const burnBudget = budget / 2n;
  const ventures = [];
  for (let i = 0; i < topCoins.length; i++) {
    const [coin, vol] = topCoins[i];
    const spend = (burnBudget * BigInt(weights[i])) / 100n;
    const entry = { coin, volumeEth: ethers.formatEther(vol), spendEth: ethers.formatEther(spend), burnedTokens: "0", burnTx: null };
    // v1 burns only WETH-paired ventures (path-free route); stock pairs skip.
    const listing = await factory.listings(coin);
    if (spend > 0n && listing.pair.toLowerCase() === dep.contracts.weth.toLowerCase() && !DRY_RUN) {
      const erc = new ethers.Contract(coin, ERC20_ABI, wallet);
      const before = await erc.balanceOf(wallet.address);
      await (await router.buy(coin, "0x", 0, { value: spend })).wait();
      const got = (await erc.balanceOf(wallet.address)) - before;
      const tx = await (await erc.transfer(DEAD, got)).wait();
      entry.burnedTokens = got.toString();
      entry.burnTx = tx.hash;
    }
    ventures.push(entry);
  }

  // 3b) ETH rebates to the top-10 traders, pro-rata by volume.
  const topTraders = [...byTrader.entries()].sort((a, b) => (b[1] > a[1] ? 1 : -1)).slice(0, 10);
  const rebateBudget = budget - burnBudget;
  const traderVolume = topTraders.reduce((a, [, v]) => a + v, 0n);
  const rebates = [];
  for (const [trader, vol] of topTraders) {
    const amount = traderVolume === 0n ? 0n : (rebateBudget * vol) / traderVolume;
    const entry = { trader, volumeEth: ethers.formatEther(vol), amountEth: ethers.formatEther(amount), tx: null };
    if (amount > 0n && !DRY_RUN) {
      const tx = await (await wallet.sendTransaction({ to: trader, value: amount })).wait();
      entry.tx = tx.hash;
    }
    rebates.push(entry);
  }

  // 4) Publish the manifest and advance the cursor.
  const manifest = {
    epoch, fromBlock, toBlock,
    totalVolumeEth: ethers.formatEther(totalVolume),
    budgetEth: ethers.formatEther(budget),
    ventures, rebates,
    dryRun: DRY_RUN, generatedAt: new Date().toISOString(),
  };
  writeFileSync(join(MANIFEST_DIR, `epoch-${epoch}.json`), JSON.stringify(manifest, null, 2));
  writeFileSync(indexPath, JSON.stringify({ epoch, lastBlock: toBlock }, null, 2));
  console.log(`epoch ${epoch} published: ${ventures.length} burns, ${rebates.length} rebates`);
}
main().catch((e) => { console.error(e); process.exit(1); });
