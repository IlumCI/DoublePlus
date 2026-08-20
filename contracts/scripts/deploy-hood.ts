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

  // The hook takes the factory address as an immutable constructor arg, but
  // the factory needs the hook's address too. Break the cycle by predicting
  // the factory's CREATE address from the deployer nonce: the hook deploy
  // (via the CREATE2 deployer) consumes one nonce, the factory the next.
  const nonce = await ethers.provider.getTransactionCount(signer.address);
  const predictedFactory = ethers.getCreateAddress({ from: signer.address, nonce: nonce + 1 });

  const Hook = await ethers.getContractFactory("HoodHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [POOL_MANAGER, predictedFactory, admin],
  );
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
  console.log("hook:", hookAddr, "(factory:", predictedFactory, "treasury:", admin, ")");

  const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
  const factory = await (await ethers.getContractFactory("HoodFactory")).deploy(signer.address, admin, POOL_MANAGER, hookAddr, WETH, STATE_VIEW);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  if (factoryAddr.toLowerCase() !== predictedFactory.toLowerCase())
    throw new Error(`factory address mismatch: got ${factoryAddr}, hook expects ${predictedFactory}`);
  console.log("factory:", factoryAddr);

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, factoryAddr, WETH, V3_ROUTER);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);

  await (await factory.renounceOwnership()).wait();
  console.log("factory ownership renounced (hook has no owner)");

  const startBlock = await ethers.provider.getBlockNumber();
  const out = {
    chainId: 4663,
    admin,
    startBlock,
    contracts: { hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr, poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER },
  };
  mkdirSync(join(__dirname, "../deployments"), { recursive: true });
  writeFileSync(join(__dirname, "../deployments/robinhood-hood.json"), JSON.stringify(out, null, 2));
  console.log("saved deployments/robinhood-hood.json  startBlock:", startBlock);
}
main().catch((e) => { console.error(e); process.exit(1); });
