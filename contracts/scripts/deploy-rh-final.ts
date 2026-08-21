import { ethers } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;

function mineFlags(deployer: string, initCodeHash: string) {
  for (let i = 0n; i < 4_000_000n; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if ((BigInt(addr) & FLAG_MASK) === HOOK_FLAGS) return { addr, salt };
  }
  throw new Error("hook salt not found");
}

async function main() {
  const [signer] = await ethers.getSigners();
  const admin = process.env.ADMIN ?? signer.address; // hardcoded admin, survives renounce
  const renounce = process.env.RENOUNCE !== "0";
  console.log("deployer:", signer.address, "| admin:", admin, "| renounce:", renounce);
  console.log("balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");

  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhFinalHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [POOL_MANAGER, signer.address]);
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  console.log("mining hook flags…");
  const { addr: hookAddr, salt } = mineFlags(c2Addr, ethers.keccak256(hookInit));
  await (await c2.deploy(salt, hookInit)).wait();
  console.log("RhFinalHook:", hookAddr);
  const hook = await ethers.getContractAt("RhFinalHook", hookAddr);

  const factory = await (await ethers.getContractFactory("RhFinalFactory")).deploy(signer.address, admin, POOL_MANAGER, hookAddr);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("RhFinalFactory:", factoryAddr);

  await (await hook.setFactory(factoryAddr)).wait();
  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, factoryAddr, WETH, V3_ROUTER);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("RhRouter:", routerAddr);

  if (renounce) {
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    console.log("ownership renounced (owner=0x0); admin retains control:", admin);
  }

  const out = {
    network: "robinhood", chainId: 4663, startBlock: await ethers.provider.getBlockNumber(),
    deployer: signer.address, admin, renounced: renounce,
    note: "Final reward model: coin pairs against a chosen stock/meme/ETH; that token is the holder reward. 80% holders / 20% creator. Ownership renounced; immutable admin keeps pause/collect/setFactory.",
    v4: { poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER },
    contracts: { hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr },
  };
  writeFileSync(join(__dirname, "../deployments/robinhood-rh-final.json"), JSON.stringify(out, null, 2));
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}
main().catch((e) => { console.error(e); process.exit(1); });
