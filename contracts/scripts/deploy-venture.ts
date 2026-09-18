import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Venture (doubleplus) launchpad deploy. Serves both Robinhood Chain
// networks through the env-driven `robinhood` network entry:
//
//   mainnet: ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=4663
//   testnet: ROBINHOOD_RPC_URL=https://rpc.testnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=46630
//
// Env:
//   ADMIN            protocolAdmin for the factory's LP-recovery lever (default: deployer)
//   TREASURY         protocol fee treasury baked into the hook (default: ADMIN)
//   PLATFORM_FEE_BPS protocol fee on every trade, 50..100 (default 100 = 1%)
//   REF_SHARE_BPS    referrer's cut of the protocol fee, 0..5000 (default 2000 = 20%)
//
// The V4 PoolManager sits at the same address on both networks. WETH differs;
// the testnet has no self-deployed V3 stack, so venture launches there are
// WETH-paired only (v3Router = zero, never called for WETH pairs).
const INFRA: Record<number, { poolManager: string; weth: string; v3Router: string; file: string }> = {
  4663: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    weth: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73",
    v3Router: "0xCaf681a66D020601342297493863E78C959E5cb2",
    file: "venture-robinhood.json",
  },
  46630: {
    poolManager: "0x8366a39cc670b4001a1121b8f6a443a643e40951",
    weth: "0x33e4191705c386532ba27cBF171Db86919200B94", // canonical WETH9 (verified, bridge-wrapped)
    v3Router: ethers.ZeroAddress,
    file: "venture-testnet.json",
  },
};

// beforeInitialize | afterSwap | afterSwapReturnDelta
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const infra = INFRA[chainId];
  if (!infra) throw new Error(`no venture infra config for chain ${chainId}`);

  const [signer] = await ethers.getSigners();
  const admin = process.env.ADMIN ?? signer.address;
  const treasury = process.env.TREASURY ?? admin;
  const platformFeeBps = Number(process.env.PLATFORM_FEE_BPS ?? 55);
  const refShareBps = Number(process.env.REF_SHARE_BPS ?? 2000);
  // Curve-phase protocol fees. Immutable once deployed, so they are set here.
  const curveBuyFeeBps = Number(process.env.CURVE_BUY_FEE_BPS ?? 50);
  const curveSellFeeBps = Number(process.env.CURVE_SELL_FEE_BPS ?? 100);
  // Smallest raise the platform will finish. Immutable on the factory, so it
  // is a deploy-time decision: mainnet ships 0.5 ETH, testnets override it
  // down so a raise can actually be driven to graduation.
  const minTargetWei = ethers.parseEther(process.env.MIN_TARGET_ETH ?? "0.5");
  console.log(`network: ${network.name} (${chainId})  deployer: ${signer.address}`);
  console.log(`admin: ${admin}  treasury: ${treasury}  platformFeeBps: ${platformFeeBps}  refShareBps: ${refShareBps}`);
  console.log(`curveBuyFeeBps: ${curveBuyFeeBps}  curveSellFeeBps: ${curveSellFeeBps}`);
  console.log(`minTargetWei: ${ethers.formatEther(minTargetWei)} ETH`);

  // 1) CREATE2 deployer + vesting deployer, then pin the factory address two
  //    creates ahead so the hook (immutable launcher) and the token deployer
  //    can both bake it in before the factory exists.
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();

  const nonce = await ethers.provider.getTransactionCount(signer.address);
  // nonce n+0: hook deploy tx (CREATE2 via c2 — does not consume a signer create)
  // ...but it IS a tx from the signer, so plain creates land at n+1 and n+2.
  const predictedFactory = ethers.getCreateAddress({ from: signer.address, nonce: nonce + 2 });

  // 2) Mine + deploy the hook at a flag-matching address, launcher pre-baked.
  const Hook = await ethers.getContractFactory("VentureFeeHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "uint16", "uint16"],
    [infra.poolManager, treasury, predictedFactory, platformFeeBps, refShareBps],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 4_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  console.log("hook:", hookAddr);

  // 3) Token deployer bound to the predicted factory, then the factory itself.
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();

  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    signer.address, admin, infra.poolManager, hookAddr, infra.weth, infra.v3Router,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(),
    curveBuyFeeBps, curveSellFeeBps, minTargetWei,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  if (factoryAddr !== predictedFactory) throw new Error(`factory address drift: ${factoryAddr} != ${predictedFactory}`);
  console.log("factory:", factoryAddr);

  const router = await (await ethers.getContractFactory("VentureRouter")).deploy(
    infra.poolManager, factoryAddr, infra.weth, infra.v3Router,
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);

  const updates = await (await ethers.getContractFactory("VentureUpdates")).deploy(factoryAddr);
  await updates.waitForDeployment();
  console.log("updates:", await updates.getAddress());

  await (await factory.renounceOwnership()).wait();
  console.log("factory ownership renounced (hook has no owner by construction)");

  const startBlock = await ethers.provider.getBlockNumber();
  const out = {
    chainId,
    admin,
    treasury,
    platformFeeBps,
    refShareBps,
    curveBuyFeeBps,
    curveSellFeeBps,
    startBlock,
    contracts: {
      hookDeployer: c2Addr,
      hook: hookAddr,
      factory: factoryAddr,
      router: routerAddr,
      updates: await updates.getAddress(),
      tokenDeployer: await tokenDeployer.getAddress(),
      vestingDeployer: await vestingDeployer.getAddress(),
      poolManager: infra.poolManager,
      weth: infra.weth,
      v3Router: infra.v3Router,
    },
  };
  mkdirSync(join(__dirname, "../deployments"), { recursive: true });
  writeFileSync(join(__dirname, `../deployments/${infra.file}`), JSON.stringify(out, null, 2));
  console.log(`saved deployments/${infra.file}  startBlock:`, startBlock);
}
main().catch((e) => { console.error(e); process.exit(1); });
