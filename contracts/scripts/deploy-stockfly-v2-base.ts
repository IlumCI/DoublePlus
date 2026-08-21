import { ethers } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Base mainnet
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const B20_FACTORY = "0xB20f000000000000000000000000000000000000";
const START_MCAP_USD8 = 4000n * 10n ** 8n; // $4,000 starting market cap
// beforeInitialize (1<<13) + afterSwap (1<<6) + afterSwapReturnDelta (1<<2)
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;

// Curated stock pairs listed at deploy (any pair is allowed anyway).
const STOCK_PAIRS = [
  "0xFF05E1bD696900dc6A52CA35Ca61Bb1024eDa8e2", // wtMSTR
];

async function main() {
  const [signer] = await ethers.getSigners();
  const admin = process.env.ADMIN ?? signer.address; // treasury + platform admin
  console.log("deployer:", signer.address, "admin/treasury:", admin);

  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();
  console.log("hookDeployer:", c2Addr);

  const vd = await (await ethers.getContractFactory("RewardVaultDeployer")).deploy();
  await vd.waitForDeployment();
  const vdAddr = await vd.getAddress();
  console.log("rewardVaultDeployer:", vdAddr);
  const keeper = process.env.KEEPER ?? admin;

  // hook -> factory circular edge. Pin exact nonces to remove any RPC-lag
  // ambiguity: c2.deploy(salt) uses `base`, the factory uses `base + 1`.
  const base = await ethers.provider.getTransactionCount(signer.address, "pending");
  const predictedFactory = ethers.getCreateAddress({ from: signer.address, nonce: base + 1 });

  const Hook = await ethers.getContractFactory("StockFeeHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [POOL_MANAGER, admin, predictedFactory, admin], // poolManager, treasury, launcher, platformAdmin
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 3_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit, { nonce: base })).wait();
  console.log("hook:", hookAddr);

  const factory = await (await ethers.getContractFactory("StockFlyFactoryV2")).deploy(
    signer.address, admin, POOL_MANAGER, hookAddr, WETH, B20_FACTORY, vdAddr, keeper, START_MCAP_USD8, { nonce: base + 1 },
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  if (factoryAddr.toLowerCase() !== predictedFactory.toLowerCase())
    throw new Error(`factory mismatch: got ${factoryAddr}, hook expects ${predictedFactory}`);
  console.log("factory:", factoryAddr);

  const router = await (await ethers.getContractFactory("FlyRouter")).deploy(POOL_MANAGER, factoryAddr, WETH, V3_ROUTER);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);


  await (await factory.renounceOwnership()).wait();
  console.log("factory ownership renounced");

  const startBlock = await ethers.provider.getBlockNumber();
  const out = {
    chainId: 8453,
    admin,
    startBlock,
    contracts: {
      hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr,
      poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER, b20Factory: B20_FACTORY,
      rewardVaultDeployer: vdAddr, keeper,
    },
    stockPairs: STOCK_PAIRS,
  };
  mkdirSync(join(__dirname, "../deployments"), { recursive: true });
  writeFileSync(join(__dirname, "../deployments/base-stockfly-v2.json"), JSON.stringify(out, null, 2));
  console.log("saved deployments/base-stockfly.json  startBlock:", startBlock);
}
main().catch((e) => { console.error(e); process.exit(1); });
