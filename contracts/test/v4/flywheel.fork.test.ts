import { expect } from "chai";
import { ethers, network } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;
const WEEK = 7 * 24 * 3600;

describe("Flywheel: 20/25/25/30 + weekly top-3 burn + trader claims (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("runs the flywheel lifecycle", async () => {
    const [admin, creator, t1, t2] = await ethers.getSigners();

    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });

    const Hook = await ethers.getContractFactory("FlywheelHook");
    const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address"],
      [POOL_MANAGER, predictedFactory, admin.address, WETH],
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
    const hook = await ethers.getContractAt("FlywheelHook", hookAddr);

    const factory = await (await ethers.getContractFactory("FlyFactory")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH,
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());
    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
    await router.waitForDeployment();

    const weth = await ethers.getContractAt("FlyToken", WETH);

    // Coin A: launch with atomic dev buy (flat 1%, no sniper premium).
    const pA = { name: "Alpha", symbol: "ALPHA", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8 };
    await (await factory.connect(creator).launch(pA, ethers.hexlify(ethers.randomBytes(32)), { value: ethers.parseEther("0.004") })).wait();
    const coinA = await factory.allTokens(0n);
    const ercA = await ethers.getContractAt("FlyToken", coinA);
    expect(await ercA.balanceOf(creator.address), "dev buy delivered").to.be.greaterThan(0n);

    // Coin B: plain launch.
    const pB = { name: "Beta", symbol: "BETA", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8 };
    await (await factory.connect(creator).launch(pB, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coinB = await factory.allTokens(1n);

    // Sniper premium accrues on an instant buy of A -> community-bound.
    await (await router.connect(t1).buy(coinA, "0x", 0, { value: ethers.parseEther("0.02") })).wait();
    expect(await hook.tokenFeesSniper(coinA), "sniper premium accrued").to.be.greaterThan(0n);

    // Age past the sniper window, then trade: A gets more volume than B.
    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine");
    await (await router.connect(t2).buy(coinA, "0x", 0, { value: ethers.parseEther("0.03") })).wait();
    await (await router.connect(t1).buy(coinB, "0x", 0, { value: ethers.parseEther("0.01") })).wait();

    const e0 = await hook.currentEpoch();
    expect(await hook.traderVol(e0, t1.address), "t1 volume tracked").to.be.greaterThan(0n);
    const top = await hook.topTokens(e0);
    expect(top[0], "A leads the leaderboard").to.equal(coinA);
    expect(top[1], "B is second").to.equal(coinB);

    // Harvest both: 20% creator / 25% treasury, pots fill.
    const cB = await weth.balanceOf(creator.address);
    const aB = await weth.balanceOf(admin.address);
    await (await hook.harvest(coinA)).wait();
    await (await hook.harvest(coinB)).wait();
    const cGot = (await weth.balanceOf(creator.address)) - cB;
    const aGot = (await weth.balanceOf(admin.address)) - aB;
    expect(cGot, "deployer 20%").to.be.greaterThan(0n);
    expect(aGot, "platform 25%").to.be.greaterThan(0n);
    expect(aGot, "platform >= deployer").to.be.greaterThanOrEqual(cGot);
    expect(await hook.communityPot(), "community pot filled").to.be.greaterThan(0n);
    expect(await hook.traderPot(e0), "trader pot filled").to.be.greaterThan(0n);

    // Epoch cannot resolve while open.
    await expect(hook.resolveEpoch(e0)).to.be.reverted;

    // A week later: the community pot buys back and burns the top coins.
    await network.provider.send("evm_increaseTime", [WEEK + 60]);
    await network.provider.send("evm_mine");
    const supplyA = await ercA.totalSupply();
    const pot = await hook.communityPot();
    await (await hook.resolveEpoch(e0)).wait();
    expect(await ercA.totalSupply(), "top coin burned").to.be.lessThan(supplyA);
    expect(await hook.communityPot(), "pot spent").to.be.lessThan(pot);
    expect(await hook.epochResolved(e0)).to.equal(true);

    // Trader claims their WETH share of the epoch pot.
    const t1B = await weth.balanceOf(t1.address);
    await (await hook.connect(t1).claimTrader(e0)).wait();
    expect((await weth.balanceOf(t1.address)) - t1B, "trader paid in WETH").to.be.greaterThan(0n);
    await expect(hook.connect(t1).claimTrader(e0), "no double claim").to.be.reverted;
  });
});
