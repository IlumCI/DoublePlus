import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

/**
 * Live audit of the v2 deployment. Part 1 checks every piece of on-chain
 * config the protocol depends on (the class of bug that bit v1 was a
 * mis-sorted stock pool key — every key is re-checked here against the real
 * PoolManager state). Part 2 is an end-to-end smoke test with real funds:
 * tiny buy -> tax accrues -> harvest -> NVDA pushed to the holder's wallet
 * via claimForMany, proving the whole v2 reward path on mainnet.
 */

const ZERO = "0x0000000000000000000000000000000000000000";
const ADMIN = "0x0315eCb53F64b7A4bA56bb8A4DAB0D96F0856b60";
const POOLS_SLOT = 6n; // PoolManager pools mapping slot (extsload)

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  console.log(`${ok ? "  ✅" : "  ❌"} ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

function poolId(key: { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string }) {
  return ethers.keccak256(
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "uint24", "int24", "address"],
      [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks],
    ),
  );
}

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/quiver-v4.json"), "utf8"));
  const cfg = JSON.parse(readFileSync(join(__dirname, "../config/v4-stocks.json"), "utf8"));
  const { factory: FAC, hook: HOOK, router: ROUTER } = dep.contracts;
  const { poolManager: PM, weth: WETH, usdg: USDG } = dep.v4;

  const factory = await ethers.getContractAt("QuiverFactory", FAC);
  const hook = await ethers.getContractAt("QuiverHook", HOOK);
  const pmExt = new ethers.Contract(PM, ["function extsload(bytes32) view returns (bytes32)"], ethers.provider);

  const sqrtPriceOf = async (id: string): Promise<bigint> => {
    const stateSlot = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "uint256"], [id, POOLS_SLOT]),
    );
    return BigInt(await pmExt.extsload(stateSlot)) & ((1n << 160n) - 1n);
  };

  console.log("== 1. Factory ==");
  check("owner renounced", (await factory.owner()) === ZERO);
  check("protocolAdmin = 0x0315…", (await factory.protocolAdmin()).toLowerCase() === ADMIN.toLowerCase());
  check("launches not paused", !(await factory.launchesPaused()));
  check("total supply 1e27", (await factory.TOTAL_SUPPLY()) === 10n ** 27n);

  console.log("== 2. Hook ==");
  check("owner renounced", (await hook.owner()) === ZERO);
  check("factory wired", (await hook.factory()).toLowerCase() === FAC.toLowerCase());
  check("treasury = 0x0315…", (await hook.protocolTreasury()).toLowerCase() === ADMIN.toLowerCase());
  check("quote = USDG", (await hook.quote()).toLowerCase() === USDG.toLowerCase());
  const flags = BigInt(HOOK) & ((1n << 14n) - 1n);
  check("hook address flags afterSwap|returnDelta", flags === ((1n << 6n) | (1n << 2n)), `0b${flags.toString(2)}`);

  console.log("== 3. WETH/USDG reward route pool ==");
  const [q0, q1] = WETH.toLowerCase() < USDG.toLowerCase() ? [WETH, USDG] : [USDG, WETH];
  const quoteKey = { currency0: q0, currency1: q1, fee: cfg.wethUsdgPool.fee, tickSpacing: cfg.wethUsdgPool.tickSpacing, hooks: ZERO };
  check("WETH/USDG pool initialized", (await sqrtPriceOf(poolId(quoteKey))) > 0n);

  console.log("== 4. All 10 stock pools (sorted keys + initialized) ==");
  for (const s of cfg.stocks) {
    const listed = await factory.stockListed(s.address);
    const key = await factory.stockPool(s.address);
    const sorted = BigInt(key.currency0) < BigInt(key.currency1);
    const sqrtP = await sqrtPriceOf(
      poolId({ currency0: key.currency0, currency1: key.currency1, fee: Number(key.fee), tickSpacing: Number(key.tickSpacing), hooks: key.hooks }),
    );
    check(`${s.symbol}`, listed && sorted && sqrtP > 0n, `listed=${listed} sorted=${sorted} pool=${sqrtP > 0n ? "live" : "MISSING"}`);
  }

  console.log("== 5. Official QVR token ==");
  const qvr = await factory.allTokens(0);
  const token = await ethers.getContractAt("QuiverToken", qvr);
  check("address ends 4663", qvr.toLowerCase().endsWith("4663"), qvr);
  check("hook wired", (await token.hook()).toLowerCase() === HOOK.toLowerCase());
  check("tax 5%", (await token.taxBps()) === 500n);
  check("reward token = NVDA", (await token.rewardToken()).toLowerCase() === "0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec");
  check("PoolManager excluded from dividends", await token.excluded(PM));
  try {
    await token.claimForMany.staticCall([]);
    check("claimForMany present (v2 auto-push)", true);
  } catch {
    check("claimForMany present (v2 auto-push)", false);
  }
  const [t0, t1] = BigInt(qvr) < BigInt(WETH) ? [qvr, WETH] : [WETH, qvr];
  const qvrKey = { currency0: t0, currency1: t1, fee: 0, tickSpacing: 60, hooks: HOOK };
  check("QVR/WETH pool initialized", (await sqrtPriceOf(poolId(qvrKey))) > 0n);

  console.log("== 6. LIVE smoke test: buy -> tax -> harvest -> auto-push ==");
  const router = await ethers.getContractAt("QuiverRouter", ROUTER);
  const nvda = new ethers.Contract(
    "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider,
  );
  const buyEth = ethers.parseEther(process.env.BUY_ETH ?? "0.001");
  console.log(`  buying ${ethers.formatEther(buyEth)} ETH of QVR as ${signer.address}…`);
  await (await router.buy(qvr, 0, { value: buyEth })).wait();
  const feesTok = await hook.tokenFees(qvr);
  check("buy taxed (tokenFees accrued)", feesTok > 0n, `${ethers.formatEther(feesTok)} QVR`);
  check("eligibleSupply > 0 (real holders exist)", (await token.eligibleSupply()) > 0n);

  const nvdaBefore = await nvda.balanceOf(signer.address);
  await (await hook.harvest(qvr)).wait();
  const distributed = await token.totalRewardsDistributed();
  check("harvest distributed NVDA to holders", distributed > 0n, `${ethers.formatEther(distributed)} NVDA`);

  // Explicit gas: claimForMany swallows inner reverts, so a stale gas estimate
  // from a lagging RPC node silently delivers nothing (found by this audit).
  await (await token.claimForMany([signer.address], { gasLimit: 500_000n })).wait();
  const nvdaAfter = await nvda.balanceOf(signer.address);
  check("NVDA auto-pushed to holder wallet", nvdaAfter > nvdaBefore, `+${ethers.formatEther(nvdaAfter - nvdaBefore)} NVDA`);
  check("holder pending drained", (await token.pendingRewards(signer.address)) === 0n);

  console.log(failures === 0 ? "\nAUDIT RESULT: ALL CHECKS PASSED ✅" : `\nAUDIT RESULT: ${failures} FAILURE(S) ❌`);
  if (failures > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
