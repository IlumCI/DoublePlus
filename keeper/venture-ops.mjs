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
//   DEPLOYMENT_FILE     (default ../contracts/deployments/venture-testnet.json)
//   MIN_DELIVER         (default 1e12 wei of the reward token)
//   LOG_CHUNK           (default 500000) block span per getLogs page
//   CONFIRMATIONS       (default 3)
//   DRY_RUN             set to log intended actions without sending txs
import { ethers } from "ethers";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const depPath = process.env.DEPLOYMENT_FILE ?? join(here, "../contracts/deployments/venture-testnet.json");
const dep = JSON.parse(readFileSync(depPath, "utf8"));

const RPC = process.env.RPC_URL ?? "https://rpc.testnet.chain.robinhood.com";
const KEY = process.env.KEEPER_PRIVATE_KEY;
if (!KEY) { console.error("Set KEEPER_PRIVATE_KEY."); process.exit(1); }
const MIN_DELIVER = BigInt(process.env.MIN_DELIVER ?? "1000000000000");
const LOG_CHUNK = Number(process.env.LOG_CHUNK ?? "500000");
const CONFIRMATIONS = Number(process.env.CONFIRMATIONS ?? "3");
const DRY_RUN = process.env.DRY_RUN != null;

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
];
const TOKEN_ABI = [
  "function pendingRewards(address) view returns (uint256)",
  "function claimForMany(address[])",
];

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
  const head = (await provider.getBlockNumber()) - CONFIRMATIONS;
  const now = Math.floor(Date.now() / 1000);
  const total = Number(await factory.totalTokens());
  console.log(`venture-ops: ${total} ventures, head-${CONFIRMATIONS}=${head}, keeper=${wallet.address}${DRY_RUN ? " [DRY_RUN]" : ""}`);

  for (let i = 0; i < total; i++) {
    const coin = await factory.allTokens(i);
    const st = await factory.curveState(coin);

    if (!st.finalized && !st.aborted) {
      const targetHit = st.raisedWei >= st.targetRaiseWei || st.remainingWhole === 0n;
      if (targetHit) {
        console.log(`graduate ${coin} (raised ${ethers.formatEther(st.raisedWei)} ETH)`);
        if (!DRY_RUN) await (await factory.finalize(coin)).wait();
      } else if (now >= Number(st.deadline)) {
        console.log(`abort ${coin} (deadline passed at ${ethers.formatEther(st.raisedWei)}/${ethers.formatEther(st.targetRaiseWei)} ETH)`);
        if (!DRY_RUN) await (await factory.abort(coin)).wait();
      }
      continue; // dividends only exist after graduation
    }
    if (!st.finalized) continue;

    const token = new ethers.Contract(coin, TOKEN_ABI, wallet);
    const holders = await holdersOf(coin, head);
    const due = [];
    for (const h of holders) {
      try { if ((await token.pendingRewards(h)) >= MIN_DELIVER) due.push(h); } catch { /* skip */ }
    }
    if (due.length === 0) continue;
    console.log(`deliver dividends on ${coin}: ${due.length} holder(s)`);
    for (let j = 0; j < due.length; j += 100) {
      const batch = due.slice(j, j + 100);
      if (!DRY_RUN) await (await token.claimForMany(batch)).wait();
    }
  }
  console.log("venture-ops: done");
}
main().catch((e) => { console.error(e); process.exit(1); });
