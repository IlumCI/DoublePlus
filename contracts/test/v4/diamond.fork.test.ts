import { expect } from "chai";
import { ethers, network } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;

describe("Diamond: jeet tax to holders + 80/15/5 + wall (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("runs the diamond-curve lifecycle", async () => {
    const [admin, creator, jeet, holder] = await ethers.getSigners();

    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    // Nonce-predicted wiring, mirroring the deploy script.
    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });
    const predictedRouter = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
    const predictedDeployer = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 3 });

    const Hook = await ethers.getContractFactory("DiamondHook");
    const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address"],
      [POOL_MANAGER, predictedFactory, admin.address],
    );
    const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 500_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    await (await c2.deploy(salt, hookInit)).wait();
    const hook = await ethers.getContractAt("DiamondHook", hookAddr);

    const factory = await (await ethers.getContractFactory("DiamondFactory")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, STATE_VIEW, predictedRouter, predictedDeployer,
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());
    const router = await (await ethers.getContractFactory("DiamondRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
    await router.waitForDeployment();
    expect((await router.getAddress()).toLowerCase()).to.equal(predictedRouter.toLowerCase());
    const dep = await (await ethers.getContractFactory("DiamondTokenDeployer")).deploy(await factory.getAddress());
    await dep.waitForDeployment();
    expect((await dep.getAddress()).toLowerCase()).to.equal(predictedDeployer.toLowerCase());

    // Launch with an atomic dev buy.
    const params = { name: "Diamond", symbol: "DMND", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8 };
    const salt2 = ethers.hexlify(ethers.randomBytes(32));
    await (await factory.connect(creator).launch(params, salt2, { value: ethers.parseEther("0.005") })).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("DiamondToken", coin);
    const weth = await ethers.getContractAt("DiamondToken", WETH);
    expect(await erc.balanceOf(creator.address), "dev buy delivered").to.be.greaterThan(0n);
    expect(await erc.sellTaxBpsOf(creator.address), "fresh clock = max tier").to.equal(900);

    // Two buyers: a jeet (sells immediately) and a holder (keeps).
    await (await router.connect(jeet).buy(coin, "0x", 0, { value: ethers.parseEther("0.02") })).wait();
    await (await router.connect(holder).buy(coin, "0x", 0, { value: ethers.parseEther("0.02") })).wait();

    // Jeet sells within the hour: the +9% tier fills the jeet pot in coin.
    const jeetBal = await erc.balanceOf(jeet.address);
    await (await erc.connect(jeet).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    const potBefore = await erc.jeetPot();
    await (await router.connect(jeet).sell(coin, jeetBal, "0x", 0)).wait();
    const potAfter = await erc.jeetPot();
    expect(potAfter - potBefore, "jeet tax collected").to.be.greaterThan(0n);
    // Roughly 9% of the sold amount (allow rounding).
    expect(potAfter - potBefore).to.be.greaterThan((jeetBal * 800n) / 10_000n);

    // Harvest: creator/treasury/wall paid AND the jeet pot reaches holders as WETH.
    const rewardsBefore = await erc.totalRewardsDistributed();
    const cB = await weth.balanceOf(creator.address);
    const aB = await weth.balanceOf(admin.address);
    await (await hook.harvest(coin)).wait();
    expect((await weth.balanceOf(creator.address)) - cB, "creator 80%").to.be.greaterThan(0n);
    expect((await weth.balanceOf(admin.address)) - aB, "treasury 15%").to.be.greaterThan(0n);
    expect((await factory.walls(coin)).pending, "wall funded").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed(), "holders paid from jeet pot").to.be.greaterThan(rewardsBefore);
    expect(await erc.pendingRewards(holder.address), "holder has pending WETH").to.be.greaterThan(0n);
    expect(await erc.jeetPot(), "pot swept").to.equal(0n);

    // Holder claims WETH.
    const hB = await weth.balanceOf(holder.address);
    await (await erc.connect(holder).claim()).wait();
    expect((await weth.balanceOf(holder.address)) - hB, "claimed WETH").to.be.greaterThan(0n);

    // After 25 hours the holder sells with NO jeet tax.
    await network.provider.send("evm_increaseTime", [25 * 3600]);
    await network.provider.send("evm_mine");
    expect(await erc.sellTaxBpsOf(holder.address), "aged out of the curve").to.equal(0);
    const pot2 = await erc.jeetPot();
    const hold = await erc.balanceOf(holder.address);
    await (await erc.connect(holder).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(holder).sell(coin, hold / 2n, "0x", 0)).wait();
    expect(await erc.jeetPot(), "aged sell pays no jeet tax").to.equal(pot2);

    // Wall still bumps.
    await (await factory.bumpWall(coin)).wait();
    expect((await factory.walls(coin)).pos.liquidity, "wall placed").to.be.greaterThan(0n);
  });
});
