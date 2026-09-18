import { expect } from "chai";
import { ethers, network } from "hardhat";

// Defaults are Robinhood mainnet (4663). For a testnet-fork run (46630) the
// PoolManager address is identical; override WETH with the testnet's canonical
// WETH9 and zero the V3 router (WETH pairs never touch it):
//   FORK_WETH=0x33e4191705c386532ba27cBF171Db86919200B94 FORK_V3_ROUTER=0x0000000000000000000000000000000000000000
const POOL_MANAGER = process.env.FORK_POOL_MANAGER ?? "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = process.env.FORK_WETH ?? "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = process.env.FORK_V3_ROUTER ?? "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n); // beforeInitialize | afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;
const TARGET = ethers.parseEther("2");
const DAY = 86_400;

async function deployAll(admin: any, treasury: any) {
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();

  // hook deploy is a plain tx (CREATE2 via c2), then tokenDeployer and the
  // factory are the next two creates from the admin signer.
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });

  const Hook = await ethers.getContractFactory("VentureFeeHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "uint16", "uint16"],
    [POOL_MANAGER, treasury.address, predictedFactory, 100, 2000],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 4_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  const hook = await ethers.getContractAt("VentureFeeHook", hookAddr);

  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();

  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, V3_ROUTER,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(),
     50, 100, 1n,
  );
  await factory.waitForDeployment();
  expect(await factory.getAddress()).to.equal(predictedFactory);

  const router = await (await ethers.getContractFactory("VentureRouter")).deploy(
    POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
  );
  await router.waitForDeployment();
  const updates = await (await ethers.getContractFactory("VentureUpdates")).deploy(await factory.getAddress());
  await updates.waitForDeployment();
  return { hook, factory, tokenDeployer, router, updates };
}

async function launch(factory: any, tokenDeployer: any, signer: any, pair: string) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const params = {
    name: "Venture", symbol: "VNT", metadataURI: "", pair,
    buyTaxBps: 200, sellTaxBps: 400, devWallet: ethers.ZeroAddress,
    devBps: 2500, dividendBps: 2500, liquidityBps: 2500, mmBps: 2500,
    ethUsdPrice8: ETH_USD_8, targetRaiseWei: TARGET, raiseDurationSecs: 3 * DAY,
    maxBuyWei: TARGET, founderRaiseBps: 3000, founderSupplyBps: 1000,
    vestingSecs: 180 * DAY, mode: 0, minHoldForDividends: 0, dividendMode: 0, v3Path: "0x",
  };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address", "uint256", "uint8"],
    ["Venture", "VNT", "", 10n ** 27n, signer.address, await factory.getAddress(), 200, pair, 0n, 0],
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

  it("funds on the curve, graduates with the founder cut, trades and settles the fee policy", async () => {
    const [admin, founder, backer, whale, trader, treasury, scout] = await ethers.getSigners();
    const { hook, factory, tokenDeployer, router, updates } = await deployAll(admin, treasury);
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

    // A trade inside the sniper window succeeds and pays the premium into
    // the bid wall (the trader simply gets fewer tokens).
    await (await router.connect(whale).buy(coin, "0x", 0, { value: ethers.parseEther("0.002") })).wait();

    // Clear the sniper window, then trade at the base policy rates.
    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine");

    // BUY: fee lands in the coin. Protocol treasury (1%) and the dev wallet
    // (founder) both receive coin; the dividend bucket is normalised to WETH
    // and credited to holders inline — no keeper, no harvest step.
    const dividendsBefore = await erc.totalRewardsDistributed();
    const treasuryCoinBefore = await erc.balanceOf(treasury.address);
    const devCoinBefore = await erc.balanceOf(founder.address);
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.01") })).wait();
    const held = await erc.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    expect(await erc.balanceOf(treasury.address) - treasuryCoinBefore, "protocol fee on buys").to.be.greaterThan(0n);
    expect(await erc.balanceOf(founder.address) - devCoinBefore, "dev bucket on buys").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed() - dividendsBefore, "dividend bucket on buys").to.be.greaterThan(0n);

    // SELL: fee lands in WETH; the protocol treasury earns WETH this time and
    // the 4% sell side is settled through the same buckets.
    const weth = await ethers.getContractAt("QuiverToken", WETH);
    const treasuryWethBefore = await weth.balanceOf(treasury.address);
    const dividendsBeforeSell = await erc.totalRewardsDistributed();
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, "0x", 0)).wait();
    expect(await weth.balanceOf(treasury.address) - treasuryWethBefore, "protocol fee on sells").to.be.greaterThan(0n);
    expect(await erc.totalRewardsDistributed() - dividendsBeforeSell, "dividend bucket on sells").to.be.greaterThan(0n);

    // Referrals: the scout recruited the trader; from then on the scout earns
    // 20% of the protocol fee on everything the trader routes.
    await (await hook.connect(trader).setReferrer(scout.address)).wait();
    await expect(hook.connect(trader).setReferrer(admin.address)).to.be.revertedWithCustomError(hook, "AlreadyConfigured");
    const scoutCoinBefore = await erc.balanceOf(scout.address);
    const treasuryCoinBefore2 = await erc.balanceOf(treasury.address);
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.01") })).wait();
    const scoutGot = (await erc.balanceOf(scout.address)) - scoutCoinBefore;
    const treasuryGot = (await erc.balanceOf(treasury.address)) - treasuryCoinBefore2;
    expect(scoutGot, "referrer earns their cut").to.be.greaterThan(0n);
    // 20/80 split of the protocol fee, exact up to rounding dust.
    expect(scoutGot * 4n).to.be.closeTo(treasuryGot, treasuryGot / 100n + 4n);

    // Routed events feed the jackpot keeper's trader ranking.
    const routedLogs = await router.queryFilter(router.filters.Routed(), -1000);
    expect(routedLogs.length, "router emits Routed").to.be.greaterThan(0);

    // Founder updates feed: creator-only, event-only.
    await (await updates.connect(founder).postUpdate(coin, "shipped v1, revenue next week")).wait();
    await expect(updates.connect(trader).postUpdate(coin, "spam")).to.be.revertedWithCustomError(updates, "NotCreator");

    // A curve backer is a holder and claims dividends in WETH.
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

  it("launches a stock-paired venture: dividends paid in the tokenized stock", async function () {
    // Only meaningful against mainnet state (self-deployed V3 stack + stocks).
    if (process.env.FORK_WETH) return this.skip();
    const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
    const routes = require("../../config/rh-stock-routes.json") as { symbol: string; address: string; venue: string; fee: number }[];
    const stock = routes.find((r) => r.venue === "v3" && r.symbol === "NVDA") ?? routes.find((r) => r.venue === "v3")!;
    const buyPath = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [WETH, 100, USDG, stock.fee, stock.address],
    );
    const sellPath = ethers.solidityPacked(
      ["address", "uint24", "address", "uint24", "address"],
      [stock.address, stock.fee, USDG, 100, WETH],
    );

    const [admin, founder, whale, trader, treasury] = await ethers.getSigners();
    const { factory, tokenDeployer, router } = await deployAll(admin, treasury);

    // Launch paired against the stock; the raise converts through the V3 route.
    const Token = await ethers.getContractFactory("QuiverToken");
    const params = {
      name: "Stock Venture", symbol: "SVNT", metadataURI: "", pair: stock.address,
      buyTaxBps: 200, sellTaxBps: 300, devWallet: ethers.ZeroAddress,
      devBps: 2500, dividendBps: 5000, liquidityBps: 2500, mmBps: 0,
      ethUsdPrice8: ETH_USD_8, targetRaiseWei: TARGET, raiseDurationSecs: 3 * DAY,
      maxBuyWei: TARGET, founderRaiseBps: 2000, founderSupplyBps: 0,
      vestingSecs: 0, mode: 0, minHoldForDividends: 0, dividendMode: 0, v3Path: buyPath,
    };
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address", "uint256", "uint8"],
      ["Stock Venture", "SVNT", "", 10n ** 27n, founder.address, await factory.getAddress(), 200, stock.address, 0n, 0],
    );
    const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    const depAddr = await tokenDeployer.getAddress();
    let salt = "";
    for (let i = 0n; i < 6_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      if ((BigInt(ethers.getCreate2Address(depAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
    }
    await (await factory.connect(founder).launch(params, salt)).wait();
    const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
    const erc = await ethers.getContractAt("QuiverToken", coin);

    await (await factory.connect(whale).buy(coin, { value: ethers.parseEther("2.1") })).wait();
    await (await factory.finalize(coin)).wait();
    expect((await factory.listings(coin)).poolId).to.not.equal(ethers.ZeroHash);

    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine");

    // Trade through the router with the stock route; dividends accrue in the
    // STOCK token — hold the coin, earn NVDA.
    await (await router.connect(trader).buy(coin, buyPath, 0, { value: ethers.parseEther("0.01") })).wait();
    const held = await erc.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, sellPath, 0)).wait();
    expect(await erc.totalRewardsDistributed(), "dividends paid in the stock").to.be.greaterThan(0n);

    const stockErc = await ethers.getContractAt("QuiverToken", stock.address);
    const before = await stockErc.balanceOf(whale.address);
    await (await erc.connect(whale).claim()).wait();
    expect((await stockErc.balanceOf(whale.address)) - before, "holder claimed real stock").to.be.greaterThan(0n);
  });

  it("quotes two-sided walls and recenters them after the price moves", async () => {
    const [admin, founder, whale, trader, treasury] = await ethers.getSigners();
    const { hook, factory, tokenDeployer, router } = await deployAll(admin, treasury);
    const coin = await launch(factory, tokenDeployer, founder, WETH);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const startBlock = await ethers.provider.getBlockNumber();

    await (await factory.connect(whale).buy(coin, { value: ethers.parseEther("2.1") })).wait();
    await (await factory.finalize(coin)).wait();
    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine");

    // One buy and one sell: the MM bucket must refill BOTH sides of the book.
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.02") })).wait();
    const held = await erc.balanceOf(trader.address);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 2n, "0x", 0)).wait();

    const adds = await hook.queryFilter(hook.filters.LiquidityAdded(), startBlock);
    const walls = adds.filter((l: any) => l.args.wall);
    const wallCurrencies = new Set(walls.map((l: any) => String(l.args.currency).toLowerCase()));
    expect(walls.length, "quote walls placed").to.be.greaterThan(1);
    expect(wallCurrencies.size, "both sides of the book quoted").to.equal(2);

    // Push the price hard so the old walls go stale.
    const dump = await erc.balanceOf(trader.address);
    await (await router.connect(trader).sell(coin, dump, "0x", 0)).wait();

    // Keeper-style reconstruction: net wall bands from add/remove events.
    const removes = await hook.queryFilter(hook.filters.WallRemoved(), startBlock);
    const net = new Map<string, bigint>();
    for (const l of await hook.queryFilter(hook.filters.LiquidityAdded(), startBlock)) {
      if (!(l as any).args.wall) continue;
      const k = `${(l as any).args.tickLower}:${(l as any).args.tickUpper}`;
      net.set(k, (net.get(k) ?? 0n) + BigInt((l as any).args.liquidity));
    }
    for (const l of removes) {
      const k = `${(l as any).args.tickLower}:${(l as any).args.tickUpper}`;
      net.set(k, (net.get(k) ?? 0n) - BigInt((l as any).args.liquidity));
    }
    const bands = [...net.entries()].filter(([, v]) => v > 0n).map(([k, liquidity]) => {
      const [lower, upper] = k.split(":").map(Number);
      return { lower, upper, liquidity };
    });
    expect(bands.length).to.be.greaterThan(0);

    // Anyone can recenter; the walls migrate beside the new price.
    const tickBefore = await hook.poolTick(coin);
    await (await hook.connect(trader).recenter(coin, bands)).wait();
    const recentered = await hook.queryFilter(hook.filters.WallRecentered(), startBlock);
    expect(recentered.length, "WallRecentered emitted").to.equal(1);

    // Fresh walls sit beside the current tick, and the pool still trades.
    const addsAfter = await hook.queryFilter(hook.filters.LiquidityAdded(), Number(recentered[0].blockNumber));
    const fresh = addsAfter.filter((l: any) => l.args.wall);
    expect(fresh.length, "fresh quotes placed").to.be.greaterThan(0);
    for (const l of fresh) {
      const near = Math.min(
        Math.abs(Number((l as any).args.tickLower) - Number(tickBefore)),
        Math.abs(Number((l as any).args.tickUpper) - Number(tickBefore)),
      );
      expect(near, "fresh wall hugs the price").to.be.lessThanOrEqual(60 * 3);
    }
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.005") })).wait();
  });
});
