import { ethers } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
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
  // Immutable hardcoded admin that survives renounce. Defaults to the deployer.
  const admin = process.env.ADMIN ?? signer.address;
  const renounce = process.env.RENOUNCE !== "0";
  console.log("deployer:", signer.address, "| admin:", admin, "| renounce:", renounce);
  console.log("balance:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");

  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhRewardHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [POOL_MANAGER, signer.address, admin, WETH],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  console.log("mining hook flags…");
  const { addr: hookAddr, salt } = mineFlags(c2Addr, ethers.keccak256(hookInit));
  await (await c2.deploy(salt, hookInit)).wait();
  console.log("RhRewardHook:", hookAddr);
  const hook = await ethers.getContractAt("RhRewardHook", hookAddr);

  const factory = await (await ethers.getContractFactory("RhRewardFactory")).deploy(signer.address, admin, POOL_MANAGER, hookAddr, WETH);
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("RhRewardFactory:", factoryAddr);

  await (await hook.setFactory(factoryAddr)).wait();
  console.log("hook.setFactory done");

  const router = await (await ethers.getContractFactory("RhEthRouter")).deploy(POOL_MANAGER, hookAddr, WETH);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("RhEthRouter:", routerAddr);

  if (renounce) {
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    console.log("ownership renounced (owner=0x0); admin retains control:", admin);
  }

  const out = {
    network: "robinhood",
    chainId: 4663,
    startBlock: await ethers.provider.getBlockNumber(),
    deployer: signer.address,
    admin,
    renounced: renounce,
    note: "ETH-reward model: coin pairs against WETH, holders earn native ETH (80% of fees), creator 20%. Ownership renounced; immutable admin retains control.",
    v4: { poolManager: POOL_MANAGER, weth: WETH },
    contracts: { hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr },
  };
  const path = join(__dirname, "../deployments/robinhood-rh-reward.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("wrote", path);
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
