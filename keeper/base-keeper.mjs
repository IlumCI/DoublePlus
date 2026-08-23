// koi.fun base reward keeper.
//
// For every V3 coin: realise the holder-reward stream. A slice of each trade's
// 2% tax accrues to the coin's StockRewardVault as a mix of the coin (from
// buys) and the stock (from sells). This keeper:
//   1) convert() — swaps the vault's coin balance into the stock, so the whole
//      vault balance is the reward token;
//   2) snapshots holder balances from the coin's Transfer log (excluding the
//      pool, vault, factory, router, dead and zero addresses);
//   3) splits distributable() stock pro-rata and builds an OpenZeppelin
//      StandardMerkleTree of [index, account, amount] leaves;
//   4) postEpoch(root, amount) on the vault;
//   5) writes a proof manifest to web/public/rewards/base/<vault>.json so the
//      site can let each holder claim their stock with a proof.
//
// The vault contract lets NOBODY (keeper included) move funds except into a
// holder's hands through a posted epoch, so this keeper only ever schedules
// rewards — it can never divert them.
//
// Env:
//   KEEPER_PRIVATE_KEY   (required) the on-chain keeper wallet (pays gas)
//   BASE_RPC_URL         (default https://mainnet.base.org)
//   MIN_CONVERT_COIN     (default 1e15) min vault coin balance to bother converting
//   MIN_EPOCH_STOCK      (default 1e12) min distributable stock to post an epoch
//   LOG_CHUNK            (default 20000) block span per getLogs page
//   CONFIRMATIONS        (default 5) blocks to stay behind head for the snapshot
//   DRY_RUN              (set to skip sending txs; still writes manifests)
import { ethers } from "ethers";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// DEPLOYMENT_FILE lets fork tests point the keeper at a local deployment;
// production reads the committed mainnet record.
const depPath = process.env.DEPLOYMENT_FILE ?? join(here, "../contracts/deployments/base-stockfly-v3.json");
const dep = JSON.parse(readFileSync(depPath, "utf8"));
const MANIFEST_DIR = join(here, "../web/public/rewards/base");

const RPC = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const KEY = process.env.KEEPER_PRIVATE_KEY;
if (!KEY) { console.error("Set KEEPER_PRIVATE_KEY (the on-chain keeper wallet)."); process.exit(1); }
const MIN_CONVERT_COIN = BigInt(process.env.MIN_CONVERT_COIN ?? "1000000000000000"); // 1e15
const MIN_EPOCH_STOCK = BigInt(process.env.MIN_EPOCH_STOCK ?? "1000000000000"); // 1e12
const LOG_CHUNK = Number(process.env.LOG_CHUNK ?? "20000");
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? "5");
const DRY_RUN = process.env.DRY_RUN != null;

const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = "0x000000000000000000000000000000000000dead";
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

const FACTORY_ABI = [
  "function totalTokens() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function rewardVaultOf(address) view returns (address)",
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
];
const VAULT_ABI = [
  "function stock() view returns (address)",
  "function coin() view returns (address)",
  "function keeper() view returns (address)",
  "function distributable() view returns (uint256)",
  "function allocated() view returns (uint256)",
  "function epochCount() view returns (uint256)",
  "function convert(uint256 minStockOut) returns (uint256)",
  "function postEpoch(bytes32 root, uint256 amount) returns (uint256)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];

const provider = new ethers.JsonRpcProvider(RPC);
// Public RPCs rate-limit the keeper's log scan hard. Retry every JSON-RPC call
// with exponential backoff on rate-limit / transient errors so a busy endpoint
// doesn't abort the whole run.
{
  const origSend = provider.send.bind(provider);
  provider.send = async (method, params) => {
    for (let i = 0; ; i++) {
      try {
        return await origSend(method, params);
      } catch (e) {
        const m = String(e?.error?.message ?? e?.info?.error?.message ?? e?.shortMessage ?? e?.message ?? "").toLowerCase();
        const code = e?.error?.code ?? e?.info?.error?.code;
        const rate = code === -32016 || code === 429 || m.includes("rate limit") || m.includes("429") || m.includes("too many") || m.includes("timeout");
        if (!rate || i >= 7) throw e;
        await new Promise((r) => setTimeout(r, Math.min(15000, 600 * 2 ** i)));
      }
    }
  };
}
const keeper = new ethers.Wallet(KEY, provider);
const factory = new ethers.Contract(dep.contracts.factory, FACTORY_ABI, keeper);

// Addresses that hold the coin but are not reward-eligible holders.
const excluded = new Set([
  ZERO, DEAD,
  dep.contracts.poolManager, dep.contracts.factory, dep.contracts.router, dep.contracts.hook,
].map((a) => a.toLowerCase()));

async function main() {
  const gas = await provider.getBalance(keeper.address);
  console.log(`base-keeper ${keeper.address} · gas ${ethers.formatEther(gas)} ETH · factory ${dep.contracts.factory}`);
  if (gas === 0n && !DRY_RUN) { console.error("Keeper wallet has no gas — fund it and retry."); process.exit(1); }

  const head = await provider.getBlockNumber();
  const snapBlock = Math.max(dep.startBlock, head - CONFIRMATIONS);

  const n = Number(await factory.totalTokens());
  console.log(`coins: ${n} · snapshot block ${snapBlock}`);
  mkdirSync(MANIFEST_DIR, { recursive: true });

  for (let i = 0; i < n; i++) {
    const coin = await factory.allTokens(i);
    try {
      await processCoin(coin, snapBlock);
    } catch (e) {
      console.error(`  coin ${coin}: ${e.shortMessage ?? e.message}`);
    }
  }
}

async function processCoin(coin, snapBlock) {
  const vaultAddr = await factory.rewardVaultOf(coin);
  if (!vaultAddr || vaultAddr === ZERO) return;
  const vault = new ethers.Contract(vaultAddr, VAULT_ABI, keeper);
  const coinErc = new ethers.Contract(coin, ERC20_ABI, provider);

  // 1) Convert the vault's coin balance into the stock.
  const vaultCoin = await coinErc.balanceOf(vaultAddr);
  if (vaultCoin >= MIN_CONVERT_COIN) {
    if (DRY_RUN) console.log(`  ${coin} convert ${ethers.formatEther(vaultCoin)} coin (dry-run)`);
    else { await (await vault.convert(0)).wait(); console.log(`  ${coin} converted ${ethers.formatEther(vaultCoin)} coin -> stock`); }
  }

  // 2) Budget available for a new epoch.
  const budget = await vault.distributable();
  if (budget < MIN_EPOCH_STOCK) return;

  // 3) Snapshot holder balances from the coin's Transfer log.
  const balances = await snapshotHolders(coin, snapBlock, vaultAddr);
  const holders = [...balances.entries()].filter(([, b]) => b > 0n);
  const total = holders.reduce((s, [, b]) => s + b, 0n);
  if (total === 0n || holders.length === 0) { console.log(`  ${coin}: no eligible holders`); return; }

  // Sort for a deterministic index order, then split the budget pro-rata.
  holders.sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const values = [];
  let allocated = 0n;
  holders.forEach(([acct, bal], idx) => {
    const amt = (budget * bal) / total; // floor; remainder rolls into next epoch
    if (amt > 0n) { values.push([idx, ethers.getAddress(acct), amt.toString()]); allocated += amt; }
  });
  if (values.length === 0 || allocated === 0n) { console.log(`  ${coin}: dust-only, skipped`); return; }

  const tree = StandardMerkleTree.of(values, ["uint256", "address", "uint256"]);
  const epochId = Number(await vault.epochCount());

  // 4) Post the epoch on-chain.
  if (DRY_RUN) {
    console.log(`  ${coin} epoch ${epochId} (dry-run): ${values.length} holders, ${ethers.formatUnits(allocated, 18)} stock`);
  } else {
    await (await vault.postEpoch(tree.root, allocated)).wait();
    console.log(`  ${coin} epoch ${epochId} posted: ${values.length} holders, root ${tree.root}`);
  }

  // 5) Append the epoch's leaves + proofs to the vault manifest.
  writeManifest(vaultAddr, coin, await vault.stock(), {
    epoch: epochId,
    root: tree.root,
    block: snapBlock,
    amount: allocated.toString(),
    leaves: values.map(([index, account, amount]) => ({
      index, account, amount, proof: tree.getProof([index, account, amount]),
    })),
  });
}

// Reconstruct balances from the full Transfer history up to snapBlock.
async function snapshotHolders(coin, snapBlock, vaultAddr) {
  const balances = new Map();
  const bump = (addr, delta) => {
    const k = addr.toLowerCase();
    if (excluded.has(k) || k === vaultAddr.toLowerCase()) return;
    balances.set(k, (balances.get(k) ?? 0n) + delta);
  };
  for (let from = dep.startBlock; from <= snapBlock; from += LOG_CHUNK) {
    const to = Math.min(from + LOG_CHUNK - 1, snapBlock);
    const logs = await provider.getLogs({ address: coin, topics: [TRANSFER_TOPIC], fromBlock: from, toBlock: to });
    for (const log of logs) {
      const fromAddr = ethers.getAddress("0x" + log.topics[1].slice(26));
      const toAddr = ethers.getAddress("0x" + log.topics[2].slice(26));
      const value = BigInt(log.data);
      bump(fromAddr, -value);
      bump(toAddr, value);
    }
  }
  return balances;
}

function writeManifest(vaultAddr, coin, stock, epoch) {
  const path = join(MANIFEST_DIR, `${vaultAddr.toLowerCase()}.json`);
  let m = { vault: vaultAddr, coin, stock, epochs: [] };
  if (existsSync(path)) {
    try { m = JSON.parse(readFileSync(path, "utf8")); } catch { /* rewrite */ }
  }
  if (!m.epochs.some((e) => e.epoch === epoch.epoch)) m.epochs.push(epoch);
  m.epochs.sort((a, b) => a.epoch - b.epoch);
  writeFileSync(path, JSON.stringify(m, null, 2));
}

main().catch((e) => { console.error(e); process.exit(1); });
