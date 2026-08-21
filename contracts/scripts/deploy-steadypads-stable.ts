import { ethers, network } from "hardhat";
import { writeFileSync, readFileSync } from "fs";
import { join } from "path";

/**
 * Steadypads on Stable (chain 988, gas = USDT0) — one-shot deployment.
 *
 * Stable has no Uniswap V4 or wrapped-native yet, so this script deploys the
 * full stack from scratch:
 *   1. WrappedNative "Wrapped USDT0" (WUSDT0) — unless WRAPPED_NATIVE is set
 *   2. Uniswap V4 PoolManager (canonical artifact) — unless POOL_MANAGER is set
 *   3. HookDeployer (CREATE2) → QuiverHook (flag-mined address)
 *   4. QuiverFactory (native/USD price fixed at $1 — the native IS a dollar)
 *   5. QuiverRouter
 *   6. Dollar rewards: lists WUSDT0 itself as the sole reward asset. The hook's
 *      dollar mode skips the swap hops and pays holders wrapped dollars direct.
 *
 * Env: PROTOCOL_ADMIN (required), TREASURY, WRAPPED_NATIVE, POOL_MANAGER,
 *      VANITY=0 to skip factory vanity mining, RENOUNCE=1 to renounce owner.
 *
 *   npx hardhat run scripts/deploy-steadypads-stable.ts --network stable
 */

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;

function mine(deployer: string, initCodeHash: string, match: (addr: string) => boolean, max = 4_000_000n): string {
  for (let i = 0n; i < max; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if (match(addr)) return salt;
  }
  throw new Error("salt not found");
}

async function main() {
  const [signer] = await ethers.getSigners();
  const protocolAdmin = process.env.PROTOCOL_ADMIN;
  if (!protocolAdmin) throw new Error("Set PROTOCOL_ADMIN — the immutable protocol admin (LP unwind role).");
  const treasury = process.env.TREASURY ?? protocolAdmin;
  // Native currency on Stable is USDT0 — a dollar. 8-decimal fixed $1.00.
  const price8 = 100_000_000n;
  const vanity = process.env.VANITY !== "0";
  const renounce = process.env.RENOUNCE === "1";

  console.log("network:", network.name, "| deployer:", signer.address);
  console.log("protocolAdmin:", protocolAdmin, "| treasury:", treasury);

  // 1. Wrapped native (WUSDT0)
  let wnative = process.env.WRAPPED_NATIVE ?? "";
  if (!wnative) {
    const W = await ethers.getContractFactory("WrappedNative");
    const w = await W.deploy(process.env.WRAP_NAME ?? "Wrapped USDT0", process.env.WRAP_SYMBOL ?? "WUSDT0");
    await w.waitForDeployment();
    wnative = await w.getAddress();
    console.log("WrappedNative (WUSDT0):", wnative);
  } else {
    console.log("using existing wrapped native:", wnative);
  }

  // 2. Uniswap V4 PoolManager
  let poolManager = process.env.POOL_MANAGER ?? "";
  if (!poolManager) {
    const art = JSON.parse(
      readFileSync(
        join(__dirname, "../../node_modules/@uniswap/v4-core/out/PoolManager.sol/PoolManager.json"),
        "utf8",
      ),
    );
    const PM = new ethers.ContractFactory(art.abi, art.bytecode.object, signer);
    // initialOwner gates only protocol-fee controls on the PoolManager itself.
    const pm = await PM.deploy(protocolAdmin);
    await pm.waitForDeployment();
    poolManager = await pm.getAddress();
    console.log("PoolManager:", poolManager);
  } else {
    console.log("using existing PoolManager:", poolManager);
  }

  // 3. CREATE2 deployer + hook (flag-mined address)
  const Deployer = await ethers.getContractFactory("HookDeployer");
  const c2 = await Deployer.deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("QuiverHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [poolManager, signer.address, treasury, wnative],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  console.log("mining hook flags…");
  const hookSalt = mine(c2Addr, ethers.keccak256(hookInit), (a) => (BigInt(a) & FLAG_MASK) === HOOK_FLAGS);
  const hookAddr = ethers.getCreate2Address(c2Addr, hookSalt, ethers.keccak256(hookInit));
  await (await c2.deploy(hookSalt, hookInit)).wait();
  const hook = await ethers.getContractAt("QuiverHook", hookAddr);
  console.log("hook:", hookAddr);

  // 4. Factory — vanity address ending 0988 (chain id homage), optional.
  const Factory = await ethers.getContractFactory("QuiverFactory");
  const facArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address", "uint256"],
    [signer.address, protocolAdmin, poolManager, hookAddr, wnative, price8],
  );
  const facInit = ethers.concat([Factory.bytecode, facArgs]);
  console.log(vanity ? "mining factory vanity …988…" : "deploying factory…");
  const facSalt = mine(c2Addr, ethers.keccak256(facInit), (a) => !vanity || a.toLowerCase().endsWith("988"));
  const facAddr = ethers.getCreate2Address(c2Addr, facSalt, ethers.keccak256(facInit));
  await (await c2.deploy(facSalt, facInit)).wait();
  const factory = await ethers.getContractAt("QuiverFactory", facAddr);
  console.log("factory:", facAddr);

  // 5. Wire the hook, then list WUSDT0 itself as the sole reward — dollar mode.
  //    The pool key recorded for it is never used (the hook's dollar path skips
  //    both swap hops), so a placeholder key is fine.
  await (await hook.setFactory(facAddr)).wait();
  const zero = "0x0000000000000000000000000000000000000000";
  const [c0, c1] = zero.toLowerCase() < wnative.toLowerCase() ? [zero, wnative] : [wnative, zero];
  await (
    await factory.listStock(wnative, { currency0: c0, currency1: c1, fee: 0, tickSpacing: 60, hooks: zero })
  ).wait();
  console.log("listed dollar reward (WUSDT0)");

  // 6. Router
  const Router = await ethers.getContractFactory("QuiverRouter");
  const router = await Router.deploy(poolManager, wnative, hookAddr);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);

  const newOwner = process.env.NEW_OWNER ?? "";
  if (renounce) {
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    console.log("ownership renounced — protocolAdmin retains only LP unwind");
  } else if (newOwner) {
    await (await hook.transferOwnership(newOwner)).wait();
    await (await factory.transferOwnership(newOwner)).wait();
    console.log("ownership ->", newOwner);
  } else {
    console.log("ownership NOT transferred (owner =", signer.address, ")");
  }

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    startBlock: await ethers.provider.getBlockNumber(),
    deployer: signer.address,
    protocolAdmin,
    treasury,
    renounced: renounce,
    nativeUsdPrice8: price8.toString(),
    v4: { poolManager, weth: wnative, usdg: wnative },
    contracts: { create2Deployer: c2Addr, hook: hookAddr, factory: facAddr, router: routerAddr },
    rewards: [{ symbol: "WUSDT0", address: wnative, mode: "dollar" }],
  };
  const path = join(__dirname, "../deployments/steadypads-stable.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("saved", path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
