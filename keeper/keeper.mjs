// Quiver harvest keeper.
//
// Walks every launched token and calls the hook's permissionless `harvest`
// on the ones whose accrued trade tax has crossed a threshold — realising the
// 50/25/25 split (holder stock reward / creator WETH / protocol WETH). Runs on
// a schedule from GitHub Actions; needs a funded keeper wallet for gas.
//
// Env:
//   KEEPER_PRIVATE_KEY   (required) funded wallet that pays gas
//   ROBINHOOD_RPC_URL    (default: public RPC)
//   MIN_HARVEST_WETH     (default 0.0002e18) min WETH-side fees to harvest
//   MIN_HARVEST_TOKEN    (default 1000e18)   min token-side fees to harvest
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

const FACTORY_ABI = [
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
];
const HOOK_ABI = [
  "function wethFees(address) view returns (uint256)",
  "function tokenFees(address) view returns (uint256)",
  "function harvest(address)",
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

let harvested = 0;
let skipped = 0;
for (let i = 0; i < total; i++) {
  const token = await factory.allTokens(i);
  const [wf, tf] = await Promise.all([hook.wethFees(token), hook.tokenFees(token)]);
  if (wf < MIN_WETH && tf < MIN_TOKEN) {
    skipped++;
    continue;
  }
  try {
    const tx = await hook.harvest(token);
    await tx.wait();
    console.log(`✅ ${token} harvested (weth=${ethers.formatEther(wf)} token=${ethers.formatEther(tf)}) ${tx.hash}`);
    harvested++;
  } catch (e) {
    console.log(`⚠️ ${token} harvest failed: ${e.shortMessage ?? e.message}`);
  }
}
console.log(`done — harvested ${harvested}, skipped ${skipped} below threshold`);
