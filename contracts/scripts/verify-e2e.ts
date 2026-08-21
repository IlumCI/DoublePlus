/* End-to-end health check of the Flywheel system on chain 4663:
 * reads factory/token/hook state, executes a tiny real buy+sell through the
 * router, then confirms fees and volume ledgers moved. */
import { ethers } from "ethers";
import * as fs from "fs";

const FACTORY = "0x44F0fEF21366e9a8FA7e594FAc0166eA63efd62c";
const HOOK = "0xa775543d7CFd79de8Cf5305A60f11c990099C044";
const ROUTER = "0x7414F382cc855b318ad47B889c7eEEC1764d552F";
const UHOOD = "0x5CC5D708116e9B63Bbca1aa670536FD210FA76ef";

const factoryAbi = [
  "function allTokens(uint256) view returns (address)",
  "function totalTokens() view returns (uint256)",
  "function listings(address) view returns (address creator, address pair, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
];
const tokenAbi = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function metadataURI() view returns (string)",
  "function approve(address,uint256) returns (bool)",
];
const hookAbi = [
  "function currentEpoch() view returns (uint256)",
  "function genesis() view returns (uint256)",
  "function communityPot() view returns (uint256)",
  "function traderPot(uint256) view returns (uint256)",
  "function tokenVol(uint256,address) view returns (uint256)",
  "function traderVol(uint256,address) view returns (uint256)",
  "function topTokens(uint256) view returns (address[3])",
  "function tokenFees(address) view returns (uint256)",
  "function pairFees(address) view returns (uint256)",
];
const routerAbi = [
  "function buy(address coin, bytes v3Path, uint256 minCoinOut) payable returns (uint256)",
  "function sell(address coin, uint256 amountIn, bytes v3PathReverse, uint256 minEthOut) returns (uint256)",
];

async function main() {
  const env = fs.readFileSync(".env.deployer", "utf8");
  const m = env.match(/PRIVATE_KEY=(0x)?([0-9a-fA-F]{64})/)!;
  const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL);
  const w = new ethers.Wallet((m[1] ?? "0x") + m[2], provider);
  const factory = new ethers.Contract(FACTORY, factoryAbi, w);
  const token = new ethers.Contract(UHOOD, tokenAbi, w);
  const hook = new ethers.Contract(HOOK, hookAbi, w);
  const router = new ethers.Contract(ROUTER, routerAbi, w);

  const n: bigint = await factory.totalTokens();
  const all: string[] = [];
  for (let i = 0n; i < n; i++) all.push(await factory.allTokens(i));
  console.log("factory tokens:", all.length, "| UHOOD listed:", all.map((a) => a.toLowerCase()).includes(UHOOD.toLowerCase()));
  const l = await factory.listings(UHOOD);
  console.log("listing creator:", l.creator, "taxBps:", l.taxBps.toString());
  console.log("token:", await token.name(), await token.symbol(), "supply:", ethers.formatEther(await token.totalSupply()));
  const meta = JSON.parse(await token.metadataURI());
  console.log("metadata logo:", meta.logo);
  const myCoins0 = await token.balanceOf(w.address);
  console.log("creator coin balance (dev buy):", ethers.formatEther(myCoins0));

  const epoch: bigint = await hook.currentEpoch();
  console.log("epoch:", epoch.toString(), "genesis:", (await hook.genesis()).toString());
  const before = {
    pot: await hook.communityPot(),
    tvol: await hook.tokenVol(epoch, UHOOD),
    mvol: await hook.traderVol(epoch, w.address),
    tfees: await hook.tokenFees(UHOOD),
    pfees: await hook.pairFees(UHOOD),
  };
  console.log("before: pot", ethers.formatEther(before.pot), "tokenVol", ethers.formatEther(before.tvol), "myVol", ethers.formatEther(before.mvol));

  // Tiny real buy then sell everything it returned.
  const buyTx = await router.buy(UHOOD, "0x", 0, { value: ethers.parseEther("0.00003") });
  const buyRc = await buyTx.wait();
  console.log("buy tx:", buyTx.hash, buyRc!.status === 1 ? "OK" : "FAIL");
  const got = (await token.balanceOf(w.address)) - myCoins0;
  console.log("coins bought:", ethers.formatEther(got));

  const sellAmt = got / 2n;
  await (await token.approve(ROUTER, sellAmt)).wait();
  const sellTx = await router.sell(UHOOD, sellAmt, "0x", 0);
  const sellRc = await sellTx.wait();
  console.log("sell tx:", sellTx.hash, sellRc!.status === 1 ? "OK" : "FAIL");

  const after = {
    pot: await hook.communityPot(),
    tvol: await hook.tokenVol(epoch, UHOOD),
    mvol: await hook.traderVol(epoch, w.address),
    tfees: await hook.tokenFees(UHOOD),
    pfees: await hook.pairFees(UHOOD),
    top: await hook.topTokens(epoch),
  };
  console.log("after: tokenVol", ethers.formatEther(after.tvol), "myVol", ethers.formatEther(after.mvol));
  console.log("fees accrued: pair", ethers.formatEther(after.pfees), "coin", ethers.formatEther(after.tfees));
  console.log("top tokens:", after.top);
  console.log("volume moved:", after.tvol > before.tvol, "| trader ledger moved:", after.mvol > before.mvol, "| fees moved:", after.pfees > before.pfees || after.tfees > before.tfees);
  console.log("gas wallet left:", ethers.formatEther(await provider.getBalance(w.address)));
}

main().catch((e) => { console.error(e); process.exit(1); });
