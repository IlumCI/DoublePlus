import { expect } from "chai";
import { ethers, network } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;

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

  const factory = await (await ethers.getContractFactory("HammrFactory")).deploy(
    admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, V3_ROUTER,
  );
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
  await router.waitForDeployment();
  return { hook, factory, router };
}

async function launch(factory: any, signer: any, pair: string) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const fAddr = await factory.getAddress();
  const params = {
    name: "Lot", symbol: "LOT", metadataURI: "", pair, taxBps: 300,
    pairUsdPrice8: ETH_USD_8, ethUsdPrice8: ETH_USD_8, v3Path: "0x",
  };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    ["Lot", "LOT", "", 10n ** 27n, signer.address, fAddr, 300, pair],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 4_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(fAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity");
  await (await factory.connect(signer).launch(params, salt)).wait();
  return factory.allTokens((await factory.totalTokens()) - 1n);
}

describe("Hammr dutch-auction launchpad (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("auctions at a falling price, finalizes into a live reward pool", async () => {
    const [admin, creator, bidder, trader] = await ethers.getSigners();
    const { hook, factory, router } = await deployAll(admin);
    const coin = await launch(factory, creator, WETH);
    const erc = await ethers.getContractAt("QuiverToken", coin);

    // Price starts at 10x the floor and decays.
    const p0 = await factory.priceNow(coin);
    const state0 = await factory.auctionState(coin);
    expect(state0.finalized).to.equal(false);
    await network.provider.send("evm_increaseTime", [1800]);
    await network.provider.send("evm_mine");
    const pMid = await factory.priceNow(coin);
    expect(pMid, "price decays").to.be.lessThan(p0);

    // Bidder buys mid-auction and receives tokens immediately.
    await (await factory.connect(bidder).buy(coin, { value: ethers.parseEther("0.02") })).wait();
    const got = await erc.balanceOf(bidder.address);
    expect(got, "tokens delivered at the clearing price").to.be.greaterThan(0n);
    const state1 = await factory.auctionState(coin);
    expect(state1.raisedWei).to.be.greaterThan(0n);

    // Cannot finalize while live.
    await expect(factory.finalize(coin)).to.be.revertedWithCustomError(factory, "AuctionLive");

    // Expire and finalize: pool opens two-sided at the closing price.
    await network.provider.send("evm_increaseTime", [1900]);
    await network.provider.send("evm_mine");
    await (await factory.finalize(coin)).wait();
    const listing = await factory.listings(coin);
    expect(listing.poolId).to.not.equal(ethers.ZeroHash);
    await expect(factory.connect(bidder).buy(coin, { value: 1n })).to.be.revertedWithCustomError(factory, "AuctionClosed");

    // Post-auction trading through the router, both directions.
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.01") })).wait();
    const held = await erc.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, "0x", 0)).wait();

    // Fees harvest into holder rewards (WETH pair -> WETH rewards).
    const weth = await ethers.getContractAt("QuiverToken", WETH);
    const creatorBefore = await weth.balanceOf(creator.address);
    await (await hook.harvest(coin)).wait();
    expect(await weth.balanceOf(creator.address) - creatorBefore, "creator got 20%").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed(), "holders got 80%").to.be.greaterThan(0n);

    // The auction bidder is a holder and can claim the pair reward.
    const pending = await erc.pendingRewards(bidder.address);
    expect(pending, "auction buyer earns rewards").to.be.greaterThan(0n);
    const before = await weth.balanceOf(bidder.address);
    await (await erc.connect(bidder).claim()).wait();
    expect(await weth.balanceOf(bidder.address) - before).to.be.greaterThan(0n);
  });

  it("sells out early and finalizes immediately at the clearing price", async () => {
    const [admin, creator, whale] = await ethers.getSigners();
    const { factory } = await deployAll(admin);
    const coin = await launch(factory, creator, WETH);
    const erc = await ethers.getContractAt("QuiverToken", coin);

    // Buy the entire allocation in one shot (start price x 500M tokens).
    const p0 = await factory.priceNow(coin);
    const cost = (p0 * 500_000_000n) + ethers.parseEther("0.01");
    await (await factory.connect(whale).buy(coin, { value: cost })).wait();
    const st = await factory.auctionState(coin);
    expect(st.remaining).to.equal(0n);
    expect(await erc.balanceOf(whale.address)).to.equal(ethers.parseEther("500000000"));

    // Finalizable right away even though time remains.
    await (await factory.finalize(coin)).wait();
    expect((await factory.listings(coin)).poolId).to.not.equal(ethers.ZeroHash);
  });
});
