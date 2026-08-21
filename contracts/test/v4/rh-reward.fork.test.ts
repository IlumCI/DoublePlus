import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

async function deployAll(admin: any) {
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhRewardHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [POOL_MANAGER, admin.address, admin.address, WETH],
  );
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
  const hook = await ethers.getContractAt("RhRewardHook", hookAddr);

  const factory = await (await ethers.getContractFactory("RhRewardFactory")).deploy(admin.address, admin.address, POOL_MANAGER, hookAddr, WETH);
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const router = await (await ethers.getContractFactory("RhEthRouter")).deploy(POOL_MANAGER, hookAddr, WETH);
  await router.waitForDeployment();
  return { hook, factory, router };
}

async function launch(factory: any, signer: any, name: string, symbol: string) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const fAddr = await factory.getAddress();
  const params = { name, symbol, metadataURI: "", taxBps: 300, ethUsdPrice8: ETH_USD_8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [name, symbol, "", 10n ** 27n, signer.address, fAddr, 300, ethers.ZeroAddress],
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

describe("RhReward ETH pair, 80% holders / 20% creator (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("buys with ETH, harvests, pays holders + creator in native ETH", async () => {
    const [admin, creator, trader] = await ethers.getSigners();
    const { hook, factory, router } = await deployAll(admin);
    const coin = await launch(factory, creator, "Eth Coin", "ETHC");
    const erc = await ethers.getContractAt("QuiverToken", coin);
    expect(await erc.rewardToken()).to.equal(ethers.ZeroAddress); // native ETH rewards

    // Buy with ETH, then sell part back (accrues token- and WETH-side fees).
    await (await router.connect(trader).buy(coin, 0, { value: ethers.parseEther("0.03") })).wait();
    const held = await erc.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, 0)).wait();
    expect(await hook.tokenFees(coin)).to.be.greaterThan(0n);

    // Harvest: 80% to holders (native ETH), 20% to creator (native ETH).
    const creatorBefore = await ethers.provider.getBalance(creator.address);
    await (await hook.connect(admin).harvest(coin)).wait();
    expect(await ethers.provider.getBalance(creator.address) - creatorBefore, "creator paid ETH").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed(), "holders credited").to.be.greaterThan(0n);

    // Holder claims native ETH.
    const pending = await erc.pendingRewards(trader.address);
    expect(pending, "holder has pending ETH").to.be.greaterThan(0n);
    const before = await ethers.provider.getBalance(trader.address);
    const rc = await (await erc.connect(trader).claim()).wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(trader.address) + gas - before, "holder claimed ETH").to.be.greaterThan(0n);
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
    await expect(factory.connect(outsider).pause()).to.be.revertedWithCustomError(factory, "NotAdmin");
  });
});
