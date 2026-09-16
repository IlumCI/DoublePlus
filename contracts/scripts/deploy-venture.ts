import { ethers, network } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Venture bonding-curve launchpad deploy. Serves both Robinhood Chain
// networks through the env-driven `robinhood` network entry:
//
//   mainnet: ROBINHOOD_RPC_URL=https://rpc.mainnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=4663
//   testnet: ROBINHOOD_RPC_URL=https://rpc.testnet.chain.robinhood.com ROBINHOOD_CHAIN_ID=46630
//
// The V4 PoolManager sits at the same address on both. WETH differs; the
// testnet has no self-deployed V3 stack, so venture launches there are
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

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;

async function main() {
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const infra = INFRA[chainId];
  if (!infra) throw new Error(`no venture infra config for chain ${chainId}`);

  const [signer] = await ethers.getSigners();
  const admin = process.env.ADMIN ?? signer.address;
  console.log(`network: ${network.name} (${chainId})  deployer: ${signer.address}  admin: ${admin}`);

  // 1) CREATE2 deployer + hook at a flag-matching address.
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhFinalHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [infra.poolManager, signer.address]);
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

  // 2) Vesting deployer (unbound) + token deployer bound to the factory one
  //    nonce ahead, then the factory itself at the predicted address.
  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();

  const nonce = await ethers.provider.getTransactionCount(signer.address);
  const predictedFactory = ethers.getCreateAddress({ from: signer.address, nonce: nonce + 1 });
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();

  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    signer.address, admin, infra.poolManager, hookAddr, infra.weth, infra.v3Router,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(),
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  if (factoryAddr !== predictedFactory) throw new Error(`factory address drift: ${factoryAddr} != ${predictedFactory}`);
  console.log("factory:", factoryAddr);

  await (await hook.setFactory(factoryAddr)).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(
    infra.poolManager, factoryAddr, infra.weth, infra.v3Router,
  );
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();
  console.log("router:", routerAddr);

  await (await hook.renounceOwnership()).wait();
  await (await factory.renounceOwnership()).wait();
  console.log("ownership renounced on hook + factory");

  const startBlock = await ethers.provider.getBlockNumber();
  const out = {
    chainId,
    admin,
    startBlock,
    contracts: {
      hookDeployer: c2Addr,
      hook: hookAddr,
      factory: factoryAddr,
      router: routerAddr,
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
