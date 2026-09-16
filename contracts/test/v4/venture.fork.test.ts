import { expect } from "chai";
import { ethers, network } from "hardhat";

// Defaults are Robinhood mainnet (4663). For a testnet-fork run (46630) the
// PoolManager address is identical; override WETH with the testnet's canonical
// WETH9 and zero the V3 router (WETH pairs never touch it):
//   FORK_WETH=0x33e4191705c386532ba27cBF171Db86919200B94 FORK_V3_ROUTER=0x0000000000000000000000000000000000000000
const POOL_MANAGER = process.env.FORK_POOL_MANAGER ?? "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = process.env.FORK_WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = process.env.FORK_V3_ROUTER ?? "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;
const TARGET = ethers.parseEther("2");
const DAY = 86_400;

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

  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();

  // tokenDeployer binds to the factory one nonce ahead.
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();

  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, V3_ROUTER,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(),
  );
  await factory.waitForDeployment();
  expect(await factory.getAddress()).to.equal(predictedFactory);
  await (await hook.setFactory(await factory.getAddress())).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(
    POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
  );
  await router.waitForDeployment();
  return { hook, factory, tokenDeployer, router };
}

async function launch(factory: any, tokenDeployer: any, signer: any, pair: string) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const params = {
    name: "Venture", symbol: "VNT", metadataURI: "", pair, taxBps: 300,
    ethUsdPrice8: ETH_USD_8, targetRaiseWei: TARGET, raiseDurationSecs: 3 * DAY,
    maxBuyWei: TARGET, founderRaiseBps: 3000, founderSupplyBps: 1000,
    vestingSecs: 180 * DAY, v3Path: "0x",
  };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    ["Venture", "VNT", "", 10n ** 27n, signer.address, await factory.getAddress(), 300, pair],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  const depAddr = await tokenDeployer.getAddress();
  let salt = "";
  for (let i = 0n; i < 6_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(depAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity");
  await (await factory.connect(signer).launch(params, salt)).wait();
  return factory.allTokens((await factory.totalTokens()) - 1n);
}

describe("Venture bonding-curve launchpad (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("funds on the curve, graduates with the founder cut, trades and pays dividends", async () => {
    const [admin, founder, backer, whale, trader] = await ethers.getSigners();
    const { hook, factory, tokenDeployer, router } = await deployAll(admin);
    const coin = await launch(factory, tokenDeployer, founder, WETH);
    const erc = await ethers.getContractAt("QuiverToken", coin);

    // Curve opens at the start price and climbs as it fills.
    const p0 = await factory.priceNow(coin);
    await (await factory.connect(backer).buy(coin, { value: ethers.parseEther("0.5") })).wait();
    expect(await erc.balanceOf(backer.address)).to.be.greaterThan(0n);
    expect(await factory.priceNow(coin), "price climbs with demand").to.be.greaterThan(p0);
    await expect(factory.finalize(coin)).to.be.revertedWithCustomError(factory, "CurveLive");

    // Whale fills the rest; excess ETH beyond the curve is refunded.
    await (await factory.connect(whale).buy(coin, { value: ethers.parseEther("2") })).wait();
    const st = await factory.curveState(coin);
    expect(st.remainingWhole).to.equal(0n);
    expect(st.raisedWei).to.be.closeTo(TARGET, ethers.parseEther("0.001"));

    // Graduation: founder receives their declared 30% cut, pool goes live,
    // vesting clock starts.
    const founderEthBefore = await ethers.provider.getBalance(founder.address);
    await (await factory.finalize(coin)).wait();
    const founderCut = (await ethers.provider.getBalance(founder.address)) - founderEthBefore;
    expect(founderCut).to.be.closeTo((st.raisedWei * 3000n) / 10000n, ethers.parseEther("0.001"));
    expect((await factory.listings(coin)).poolId).to.not.equal(ethers.ZeroHash);
    await expect(factory.connect(whale).buy(coin, { value: 10n ** 15n })).to.be.revertedWithCustomError(
      factory, "CurveClosed",
    );

    const vesting = await ethers.getContractAt("FounderVesting", await factory.vestingOf(coin));
    expect(await vesting.startTime()).to.be.greaterThan(0n);
    expect(await vesting.totalAllocation()).to.equal(10n ** 26n);

    // Post-graduation trading through the router, both directions.
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.01") })).wait();
    const held = await erc.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, "0x", 0)).wait();

    // Trade fees harvest into holder dividends (80%) + founder (20%).
    const weth = await ethers.getContractAt("QuiverToken", WETH);
    const founderWethBefore = await weth.balanceOf(founder.address);
    await (await hook.harvest(coin)).wait();
    expect(await weth.balanceOf(founder.address) - founderWethBefore, "founder got 20%").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed(), "holders got 80%").to.be.greaterThan(0n);

    // A curve backer is a holder and claims dividends.
    expect(await erc.pendingRewards(backer.address)).to.be.greaterThan(0n);
    const before = await weth.balanceOf(backer.address);
    await (await erc.connect(backer).claim()).wait();
    expect(await weth.balanceOf(backer.address) - before).to.be.greaterThan(0n);

    // Vesting unlocks linearly: ~half claimable at half duration.
    await network.provider.send("evm_increaseTime", [90 * DAY]);
    await network.provider.send("evm_mine");
    const claimable = await vesting.claimable();
    expect(claimable).to.be.closeTo(10n ** 26n / 2n, 10n ** 22n);
    await (await vesting.connect(founder).claim()).wait();
    expect(await erc.balanceOf(founder.address)).to.be.greaterThanOrEqual(claimable);
  });
});
