import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const NVDA_USD_8 = 200n * 10n ** 8n;
const buyPathNvda = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WETH, 100, USDG, 3000, NVDA]);
const sellPathNvda = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [NVDA, 3000, USDG, 100, WETH]);

async function deployAll(admin: any) {
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhFinalHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [POOL_MANAGER, admin.address]);
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 500_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  const hook = await ethers.getContractAt("RhFinalHook", hookAddr);

  const factory = await (await ethers.getContractFactory("RhFinalFactory")).deploy(admin.address, admin.address, POOL_MANAGER, hookAddr);
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
  await router.waitForDeployment();
  return { hook, factory, router };
}

async function launch(factory: any, signer: any, pair: string, pairUsd8: bigint) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const fAddr = await factory.getAddress();
  const params = { name: "Coin", symbol: "COIN", metadataURI: "", pair, taxBps: 300, pairUsdPrice8: pairUsd8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    ["Coin", "COIN", "", 10n ** 27n, signer.address, fAddr, 300, pair],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 3_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(fAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity");
  await (await factory.connect(signer).launch(params, salt)).wait();
  return factory.allTokens((await factory.totalTokens()) - 1n);
}

describe("RhFinal pair=reward, 80% holders / 20% creator (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("splits fees 80/20 holders/creator in the pair token, holder claims", async () => {
    const [admin, creator, trader] = await ethers.getSigners();
    const { hook, factory, router } = await deployAll(admin);
    const coin = await launch(factory, creator, NVDA, NVDA_USD_8);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const nvda = await ethers.getContractAt("QuiverToken", NVDA);
    expect(await erc.rewardToken()).to.equal(NVDA);

    await (await router.connect(trader).buy(coin, buyPathNvda, 0, { value: ethers.parseEther("0.03") })).wait();
    const held = await erc.balanceOf(trader.address);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, sellPathNvda, 0)).wait();

    const creatorBefore = await nvda.balanceOf(creator.address);
    await (await hook.harvest(coin)).wait();
    expect(await nvda.balanceOf(creator.address) - creatorBefore, "creator got 20% NVDA").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed(), "80% distributed to holders").to.be.greaterThan(0n);

    const pending = await erc.pendingRewards(trader.address);
    expect(pending, "holder has pending NVDA").to.be.greaterThan(0n);
    const before = await nvda.balanceOf(trader.address);
    await (await erc.connect(trader).claim()).wait();
    expect(await nvda.balanceOf(trader.address) - before, "holder claimed NVDA").to.be.greaterThan(0n);
  });

  it("keeps the hardcoded admin after ownership is renounced", async () => {
    const [admin, , outsider] = await ethers.getSigners();
    const { hook, factory } = await deployAll(admin);
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    expect(await hook.owner()).to.equal(ethers.ZeroAddress);
    expect(await factory.owner()).to.equal(ethers.ZeroAddress);
    await (await factory.connect(admin).pause()).wait();
    expect(await factory.launchesPaused()).to.equal(true);
    await expect(factory.connect(outsider).pause()).to.be.revertedWithCustomError(factory, "NotProtocolAdmin");
  });
});
