import { ethers } from "hardhat";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// Stand up the V3 system on a standalone Base fork node, launch a coin, and
// trade from two holders so the reward vault accrues fees. Writes a deployment
// record the base keeper can consume (DEPLOYMENT_FILE). Keeper = signer #0 so
// base-keeper.mjs can sign convert/postEpoch with the well-known hardhat key.
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

async function main() {
  const [admin, creator, holderA, holderB] = await ethers.getSigners();
  const keeperAddr = admin.address; // signer #0 doubles as keeper on the fork

  const b20f = await (await ethers.getContractFactory("MockB20Factory")).deploy();
  await b20f.waitForDeployment();
  const vd = await (await ethers.getContractFactory("RewardVaultDeployer")).deploy();
  await vd.waitForDeployment();
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const base = await ethers.provider.getTransactionCount(admin.address, "pending");
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: base + 1 });
  const Hook = await ethers.getContractFactory("StockFeeHookV3");
  const hookInit = ethers.concat([
    Hook.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address"], [POOL_MANAGER, admin.address, predictedFactory, admin.address]),
  ]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 800_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  await (await c2.deploy(salt, hookInit, { nonce: base })).wait();

  const factory = await (await ethers.getContractFactory("StockFlyFactoryV3")).deploy(
    admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, await b20f.getAddress(), await vd.getAddress(), keeperAddr, 4000n * 10n ** 8n, { nonce: base + 1 },
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  const router = await (await ethers.getContractFactory("FlyRouter")).deploy(POOL_MANAGER, factoryAddr, WETH, V3_ROUTER);
  await router.waitForDeployment();
  const routerAddr = await router.getAddress();

  const startBlock = await ethers.provider.getBlockNumber();
  const p = { name: "RewardCoin", symbol: "RWD", metadataURI: "", pair: WETH, feeRecipient: ethers.ZeroAddress, pairUsdPrice8: ETH_USD_8 };
  await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
  const coin = await factory.allTokens(0n);
  const erc = await ethers.getContractAt("MockB20", coin);

  // Two holders buy; one partially sells so both coin- and stock-side fees land.
  await (await router.connect(holderA).buy(coin, "0x", 0, { value: ethers.parseEther("0.05") })).wait();
  await (await router.connect(holderB).buy(coin, "0x", 0, { value: ethers.parseEther("0.03") })).wait();
  await (await erc.connect(holderA).approve(routerAddr, ethers.MaxUint256)).wait();
  await (await router.connect(holderA).sell(coin, (await erc.balanceOf(holderA.address)) / 2n, "0x", 0)).wait();

  const out = {
    chainId: 8453, startBlock,
    contracts: {
      hookDeployer: c2Addr, hook: hookAddr, factory: factoryAddr, router: routerAddr,
      poolManager: POOL_MANAGER, weth: WETH, v3Router: V3_ROUTER, rewardVaultDeployer: await vd.getAddress(), keeper: keeperAddr,
    },
    fork: { coin, holderA: holderA.address, holderB: holderB.address, vault: await factory.rewardVaultOf(coin) },
  };
  mkdirSync(join(__dirname, "../deployments"), { recursive: true });
  writeFileSync(join(__dirname, "../deployments/base-stockfly-v3.fork.json"), JSON.stringify(out, null, 2));
  console.log("fork setup done. coin:", coin, "vault:", out.fork.vault, "startBlock:", startBlock);
}
main().catch((e) => { console.error(e); process.exit(1); });
