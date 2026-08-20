import { ethers, network } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

// Live Uniswap V4 + V3 infra on Robinhood Chain (chain 4663).
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;

function mineFlags(deployer: string, initCodeHash: string): { addr: string; salt: string } {
  for (let i = 0n; i < 4_000_000n; i++) {
    const salt = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployer, salt, initCodeHash);
    if ((BigInt(addr) & FLAG_MASK) === HOOK_FLAGS) return { addr, salt };
  }
  throw new Error("hook salt not found");
}

async function main() {
  const [signer] = await ethers.getSigners();
  // Platform 20% fee sink and the immutable LP-unwind admin (the user).
  const treasury = process.env.TREASURY ?? "0x5dddea56774f01fc9d207bbd7b7633596a2f4a0b";
  const protocolAdmin = process.env.PROTOCOL_ADMIN ?? treasury;
  console.log("deployer:", signer.address);
  console.log("platformTreasury:", treasury, "| protocolAdmin:", protocolAdmin);
  const bal = await ethers.provider.getBalance(signer.address);
  console.log("balance:", ethers.formatEther(bal), "ETH");

  // 1. CREATE2 deployer to place the hook at a flag-encoded address.
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();
  console.log("HookDeployer:", c2Addr);

  // 2. RhHook — owner = deployer during setup, treasury = platform sink.
  const Hook = await ethers.getContractFactory("RhHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [POOL_MANAGER, signer.address, treasury],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  console.log("mining hook flags…");
  const { addr: hookAddr, salt } = mineFlags(c2Addr, ethers.keccak256(hookInit));
  await (await c2.deploy(salt, hookInit)).wait();
  console.log("RhHook:", hookAddr);
  const hook = await ethers.getContractAt("RhHook", hookAddr);

  // 3. RhFactory.
  const factory = await (await ethers.getContractFactory("RhFactory")).deploy(
    signer.address,
    protocolAdmin,
    POOL_MANAGER,
    hookAddr,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("RhFactory:", factoryAddr);

  // 4. Wire the factory into the hook.
  await (await hook.setFactory(factoryAddr)).wait();
  console.log("hook.setFactory done");

  // 5. RhRouter (one-tap ETH<->pair<->coin).
  const router = await (await ethers.getContractFactory("RhRouter")).deploy(
    POOL_MANAGER,
    factoryAddr,
    WETH,
    V3_ROUTER,
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("RhRouter:", routerAddr);

  const block = await ethers.provider.getBlockNumber();
  const out = {
    network: "robinhood",
    chainId: 4663,
    startBlock: block,
    deployer: signer.address,
    treasury,
    protocolAdmin,
    note: "Pair=reward fork: coin pairs against a chosen stock or meme; 80% of fees to holders in that token, 20% to platform.",
    v4: { poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER },
    contracts: {
      hookDeployer: c2Addr,
      hook: hookAddr,
      factory: factoryAddr,
      router: routerAddr,
    },
  };
  const path = join(__dirname, "../deployments/robinhood-rh-fork.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("wrote", path);
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
