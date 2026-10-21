// Venture treasury keeper: turns fee income into ETH.
//
// The hook takes its fee on the swap's unspecified currency, so the treasury
// collects launched coins as well as WETH. Launched coins all fall together in
// a crash, so the treasury's coin balances are sold to ETH on a schedule rather
// than held. Every run:
//   1) tenant stacks (the deployment has a `tenant` block): pull the factory's
//      fee ledger into the FeeSplitter, redeem any ERC-6909 claims the hook
//      minted to it, and split every asset it holds between tenant and protocol;
//   2) sell up to MAX_SELL_BPS of each graduated coin the keeper wallet holds
//      through the venture router (coin -> WETH -> ETH), with a slippage floor
//      taken from a static-call quote;
//   3) unwrap any WETH the wallet holds.
//
// Step 2 sells the wallet's own coins, so it converts fees only where the
// keeper wallet is the treasury (doubleplus) or the protocol's splitter
// recipient (tenants). The flywheel already funds itself from ETH balance.
//
// Env:
//   KEEPER_PRIVATE_KEY  (required) treasury/keeper wallet; pays gas
//   RPC_URL, CHAIN_ID, DEPLOYMENT_FILE, LOG_CHUNK  as in venture-config.mjs
//   MIN_SELL_ETH        (default 0.002) skip a sale quoted below this
//   MAX_SELL_BPS        (default 2500) most of one coin holding sold per run,
//                       so a thin pool is not dumped in one block
//   SLIPPAGE_BPS        (default 300) floor below the quote
//   MAX_SPEND_ETH       (default 0.01) gas this run may spend
//   CONFIRMATIONS       (default 2)
//   DRY_RUN             log intended actions without sending txs
import { ethers } from "ethers";

import { DRY_RUN, envEth, envInt, KEY, loadDeployment, RPC } from "./venture-config.mjs";

const { dep, depPath } = loadDeployment();
const MIN_SELL_WEI = envEth("MIN_SELL_ETH", "0.002");
const MAX_SELL_BPS = BigInt(envInt("MAX_SELL_BPS", 2500, 1, 10_000));
const SLIPPAGE_BPS = BigInt(envInt("SLIPPAGE_BPS", 300, 0, 5_000));
const MAX_SPEND_WEI = envEth("MAX_SPEND_ETH", "0.01");
const CONFIRMATIONS = envInt("CONFIRMATIONS", 2, 0, 64);

const ZERO = ethers.ZeroAddress;
const ZERO_POOL = ethers.ZeroHash;

const FACTORY_ABI = [
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function feesAccrued(address) view returns (uint256)",
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
];
const ROUTER_ABI = ["function sell(address coin, uint256 amountIn, bytes v3PathReverse, uint256 minEthOut) returns (uint256)"];
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const WETH_ABI = [...ERC20_ABI, "function withdraw(uint256)"];
const SPLITTER_ABI = [
  "function pullFactory(address) returns (uint256)",
  "function redeem6909(address currency, uint256 amount)",
  "function split(address asset) returns (uint256 toTenant, uint256 toProtocol)",
  "function splittable(address asset) view returns (uint256)",
];
const PM_ABI = ["function balanceOf(address owner, uint256 id) view returns (uint256)"];

const stats = { sent: 0, spentWei: 0n, splits: 0, redeemed: 0, sold: 0, soldEthWei: 0n, unwrappedWei: 0n, skipped: 0, failed: 0, stoppedAtCap: false };
class SpendCap extends Error {}
async function send(label, fn) {
  if (DRY_RUN) { console.log(`[dry-run] ${label}`); return null; }
  if (stats.spentWei >= MAX_SPEND_WEI) { stats.stoppedAtCap = true; throw new SpendCap(label); }
  const rc = await (await fn()).wait(CONFIRMATIONS);
  stats.sent++;
  stats.spentWei += (rc?.gasUsed ?? 0n) * (rc?.gasPrice ?? rc?.effectiveGasPrice ?? 0n);
  return rc;
}

const provider = new ethers.JsonRpcProvider(RPC);
const wallet = new ethers.Wallet(KEY, provider);
const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, wallet);
const router = new ethers.Contract(dep.contracts.router, ROUTER_ABI, wallet);
const weth = new ethers.Contract(dep.contracts.weth, WETH_ABI, wallet);

async function coins() {
  const n = Number(await factory.totalTokens());
  const out = [];
  for (let i = 0; i < n; i++) {
    const coin = await factory.allTokens(i);
    const l = await factory.listings(coin);
    out.push({ coin, graduated: l.poolId !== ZERO_POOL });
  }
  return out;
}

/** Tenant stacks: everything owed to the splitter, split between both sides. */
async function serviceSplitter(all) {
  const splitter = new ethers.Contract(dep.tenant.splitter, SPLITTER_ABI, wallet);
  if ((await factory.feesAccrued(dep.tenant.splitter)) > 0n) {
    await send("splitter.pullFactory", () => splitter.pullFactory(dep.contracts.factory));
  }
  const pm = new ethers.Contract(dep.contracts.poolManager, PM_ABI, provider);
  const assets = [dep.contracts.weth, ...all.filter((c) => c.graduated).map((c) => c.coin)];
  for (const asset of assets) {
    const claims = await pm.balanceOf(dep.tenant.splitter, BigInt(asset));
    if (claims > 0n) {
      await send(`splitter.redeem6909 ${asset} ${claims}`, () => splitter.redeem6909(asset, claims));
      stats.redeemed++;
    }
  }
  for (const asset of [ZERO, ...assets]) {
    if ((await splitter.splittable(asset)) === 0n) continue;
    await send(`splitter.split ${asset}`, () => splitter.split(asset));
    stats.splits++;
  }
}

/** Sell part of one coin holding to ETH, floored at the quote less slippage. */
async function sellCoin(coin) {
  const token = new ethers.Contract(coin, ERC20_ABI, wallet);
  const held = await token.balanceOf(wallet.address);
  const amount = (held * MAX_SELL_BPS) / 10_000n;
  if (amount === 0n) return;
  const routerAddr = dep.contracts.router;
  if ((await token.allowance(wallet.address, routerAddr)) < amount) {
    await send(`approve ${coin}`, () => token.approve(routerAddr, ethers.MaxUint256));
    if (DRY_RUN) { stats.skipped++; return; } // the quote needs the approval
  }
  let quote;
  try {
    quote = await router.sell.staticCall(coin, amount, "0x", 0n);
  } catch (e) {
    console.warn(`quote failed for ${coin}: ${e.shortMessage ?? e.message}`);
    stats.failed++;
    return;
  }
  if (quote < MIN_SELL_WEI) { stats.skipped++; return; }
  const minOut = (quote * (10_000n - SLIPPAGE_BPS)) / 10_000n;
  await send(`sell ${coin} ${amount} -> >=${ethers.formatEther(minOut)} ETH`, () => router.sell(coin, amount, "0x", minOut));
  stats.sold++;
  stats.soldEthWei += quote;
}

async function main() {
  const net = await provider.getNetwork();
  if (Number(net.chainId) !== Number(dep.chainId)) {
    console.error(`chain mismatch: RPC is ${net.chainId}, ${depPath} is for ${dep.chainId}.`);
    process.exit(1);
  }
  const all = await coins();
  try {
    if (dep.tenant?.splitter) await serviceSplitter(all);
    for (const { coin, graduated } of all) {
      if (!graduated) continue;
      try { await sellCoin(coin); } catch (e) {
        if (e instanceof SpendCap) throw e;
        console.warn(`sell failed for ${coin}: ${e.shortMessage ?? e.message}`);
        stats.failed++;
      }
    }
    const wrapped = await weth.balanceOf(wallet.address);
    if (wrapped > 0n) {
      await send(`unwrap ${ethers.formatEther(wrapped)} WETH`, () => weth.withdraw(wrapped));
      stats.unwrappedWei += wrapped;
    }
  } catch (e) {
    if (!(e instanceof SpendCap)) throw e;
    console.warn(`spend cap reached at ${e.message}`);
  }
  const balance = await provider.getBalance(wallet.address);
  console.log(JSON.stringify({
    keeper: "venture-treasury", chain: Number(dep.chainId), tenant: dep.tenant?.slug ?? null, coins: all.length, ...stats,
    spentWei: stats.spentWei.toString(), soldEthWei: stats.soldEthWei.toString(), unwrappedWei: stats.unwrappedWei.toString(),
    balanceWei: balance.toString(), dryRun: DRY_RUN,
  }));
}

main().catch((e) => { console.error(e); process.exit(1); });
