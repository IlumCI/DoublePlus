import { ethers } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;

async function main() {
  const [signer] = await ethers.getSigners();
  const admin = process.env.ADMIN ?? signer.address;
  console.log("deployer:", signer.address, "admin:", admin);

  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhFinalHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [POOL_MANAGER, signer.address]);
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 2_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  console.log("hook:", hookAddr);
  const hook = await ethers.getContractAt("RhFinalHook", hookAddr);

  const factory = await (await ethers.getContractFactory("HammrFactory")).deploy(
    signer.address, admin, POOL_MANAGER, hookAddr, WETH, V3_ROUTER,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("factory:", factoryAddr);

  await (await hook.setFactory(factoryAddr)).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, factoryAddr, WETH, V3_ROUTER);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);

  await (await hook.renounceOwnership()).wait();
  await (await factory.renounceOwnership()).wait();
  console.log("ownership renounced on hook + factory");

  const startBlock = await ethers.provider.getBlockNumber();
  const out = {
    chainId: 4663,
    admin,
    startBlock,
    contracts: { hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr, poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER },
  };
  mkdirSync(join(__dirname, "../deployments"), { recursive: true });
  writeFileSync(join(__dirname, "../deployments/robinhood-hammr.json"), JSON.stringify(out, null, 2));
  console.log("saved deployments/robinhood-hammr.json  startBlock:", startBlock);
}
main().catch((e) => { console.error(e); process.exit(1); });
