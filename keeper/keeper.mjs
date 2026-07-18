// Quiver harvest keeper.
//
// Walks every launched token and calls the hook's permissionless `harvest`
// on the ones whose accrued trade tax has crossed a threshold — realising the
// 50/25/25 split (holder stock reward / creator WETH / protocol WETH). After
// each pass it auto-DELIVERS holder rewards: on v2 tokens (claimForMany) it
// pushes every holder's accrued stock straight to their wallet, so holders
// never need to claim. Runs on a schedule from GitHub Actions; needs a funded
// keeper wallet for gas.
//
// Env:
//   KEEPER_PRIVATE_KEY   (required) funded wallet that pays gas
//   ROBINHOOD_RPC_URL    (default: public RPC)
//   MIN_HARVEST_WETH     (default 0.0002e18) min WETH-side fees to harvest
//   MIN_HARVEST_TOKEN    (default 1000e18)   min token-side fees to harvest
//   MIN_CLAIM_REWARD     (default 1e12)      min pending reward to deliver
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dep = JSON.parse(readFileSync(join(here, "../contracts/deployments/quiver-v4.json"), "utf8"));

const RPC = process.env.ROBINHOOD_RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
const KEY = process.env.KEEPER_PRIVATE_KEY;
if (!KEY) {
  console.error("Set KEEPER_PRIVATE_KEY (a funded wallet that pays gas).");
  process.exit(1);
}
const MIN_WETH = BigInt(process.env.MIN_HARVEST_WETH ?? "200000000000000"); // 0.0002 WETH
const MIN_TOKEN = BigInt(process.env.MIN_HARVEST_TOKEN ?? "1000000000000000000000"); // 1000 tokens
const MIN_CLAIM = BigInt(process.env.MIN_CLAIM_REWARD ?? "1000000000000"); // dust floor (1e12 units)

const FACTORY_ABI = [
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
];
const HOOK_ABI = [
  "function wethFees(address) view returns (uint256)",
  "function tokenFees(address) view returns (uint256)",
  "function harvest(address)",
];
const TOKEN_ABI = [
  "function pendingRewards(address) view returns (uint256)",
  "function claimForMany(address[])",
  "event Transfer(address indexed from, address indexed to, uint256 value)",
];

const provider = new ethers.JsonRpcProvider(RPC);
const keeper = new ethers.Wallet(KEY, provider);
const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, keeper);
const hook = new ethers.Contract(dep.contracts.hook, HOOK_ABI, keeper);

const bal = await provider.getBalance(keeper.address);
console.log(`keeper ${keeper.address} · gas ${ethers.formatEther(bal)} ETH · factory ${dep.contracts.factory}`);
if (bal === 0n) {
  console.error("Keeper wallet has no gas — fund it and retry.");
  process.exit(1);
}

const total = Number(await factory.totalTokens());
console.log(`scanning ${total} tokens (min weth ${ethers.formatEther(MIN_WETH)} · min token ${ethers.formatEther(MIN_TOKEN)})`);

const START_BLOCK = BigInt(dep.startBlock ?? 0);

// Push every holder's accrued reward stock to their wallet (v2 tokens only —
// v1 tokens have no claimForMany and stay pull-based). Holder set is derived
// from Transfer logs; only holders above the dust floor are delivered.
async function deliverRewards(tokenAddr) {
  const token = new ethers.Contract(tokenAddr, TOKEN_ABI, keeper);
  try {
    await token.claimForMany.staticCall([]); // v1 tokens revert here
  } catch {
    return;
  }
  const latest = BigInt(await provider.getBlockNumber());
  const holders = new Set();
  const step = 1_000_000n;
  for (let from = START_BLOCK; from <= latest; from += step) {
    const to = from + step - 1n > latest ? latest : from + step - 1n;
    const logs = await token.queryFilter(token.filters.Transfer(), from, to);
    for (const l of logs) holders.add(l.args.to.toLowerCase());
  }
  holders.delete(ethers.ZeroAddress.toLowerCase());
  const list = [...holders];
  const due = [];
  for (let i = 0; i < list.length; i += 50) {
    const chunk = list.slice(i, i + 50);
    const pends = await Promise.all(chunk.map((h) => token.pendingRewards(h).catch(() => 0n)));
    for (let j = 0; j < chunk.length; j++) if (pends[j] >= MIN_CLAIM) due.push(chunk[j]);
  }
  if (!due.length) return;
  for (let i = 0; i < due.length; i += 100) {
    const batch = due.slice(i, i + 100);
    try {
      const tx = await token.claimForMany(batch);
      await tx.wait();
      console.log(`📬 ${tokenAddr} delivered rewards to ${batch.length} holder(s) ${tx.hash}`);
    } catch (e) {
      console.log(`⚠️ ${tokenAddr} delivery failed: ${e.shortMessage ?? e.message}`);
    }
  }
}

let harvested = 0;
let skipped = 0;
for (let i = 0; i < total; i++) {
  const token = await factory.allTokens(i);
  const [wf, tf] = await Promise.all([hook.wethFees(token), hook.tokenFees(token)]);
  if (wf >= MIN_WETH || tf >= MIN_TOKEN) {
    try {
      const tx = await hook.harvest(token);
      await tx.wait();
      console.log(`✅ ${token} harvested (weth=${ethers.formatEther(wf)} token=${ethers.formatEther(tf)}) ${tx.hash}`);
      harvested++;
    } catch (e) {
      console.log(`⚠️ ${token} harvest failed: ${e.shortMessage ?? e.message}`);
    }
  } else {
    skipped++;
  }
  // Deliver even when nothing was harvested this pass — pending from earlier
  // harvests still gets swept to wallets.
  try {
    await deliverRewards(token);
  } catch (e) {
    console.log(`⚠️ ${token} delivery scan failed: ${e.shortMessage ?? e.message}`);
  }
}
console.log(`done — harvested ${harvested}, skipped ${skipped} below threshold`);
