import { expect } from "chai";
import { ethers, network } from "hardhat";

import UniswapV3FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";

/**
 * ArcLaunchpadFactory + ArcSwapRouter against the REAL Uniswap V3 core
 * bytecode - the same pool code DyorSwap runs on Arc (verified onchain: the
 * Dyor factory's CREATE2 pool addresses match the canonical init code hash).
 *
 * MockUSD (6 decimals) stands in for Arc's native-USDC ERC-20 interface. On
 * Arc that interface mirrors native balances; locally the router is pre-funded
 * with MockUSD (for buys) and native (for sells) to simulate the mirror.
 */

const SUPPLY = ethers.parseEther("1000000000");
const BPS = 10_000n;
const CREATOR_BPS = 8_000n;

async function deployFixture() {
  const [deployer, owner, feeRecipient, creator, trader] = await ethers.getSigners();

  const usd = await (await ethers.getContractFactory("MockUSD")).deploy();

  const uniFactory = await new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    deployer,
  ).deploy();

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).deploy();

  const factory = await (await ethers.getContractFactory("ArcLaunchpadFactory")).deploy(
    owner.address,
    feeRecipient.address,
    await tokenDeployer.getAddress(),
    await uniFactory.getAddress(),
    await usd.getAddress(),
  );
  await tokenDeployer.setFactory(await factory.getAddress());

  const router = await (await ethers.getContractFactory("ArcSwapRouter")).deploy(
    await uniFactory.getAddress(),
    await usd.getAddress(),
  );

  // Simulate Arc's native mirror: the router "holds" quote when it holds
  // native, and pays native out when it receives quote.
  await usd.transfer(await router.getAddress(), 100_000_000n * 10n ** 6n);
  await network.provider.send("hardhat_setBalance", [
    await router.getAddress(),
    "0x" + (10n ** 24n).toString(16),
  ]);

  return { deployer, owner, feeRecipient, creator, trader, usd, uniFactory, tokenDeployer, factory, router };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

const PARAMS = { name: "Arc Token", symbol: "ARCT", metadataURI: JSON.stringify({ description: "test" }) };

async function createToken(f: Fixture, marketCapUsd8 = 0n) {
  const p = { ...PARAMS, quote: await f.usd.getAddress(), marketCapUsd8 };
  const tx = await f.factory.connect(f.creator).createToken(p);
  const rc = await tx.wait();
  const ev = rc!.logs
    .map((l: any) => { try { return f.factory.interface.parseLog(l); } catch { return null; } })
    .find((e: any) => e?.name === "TokenCreated");
  const token = ev!.args.token as string;
  const listing = await f.factory.listings(token);
  return { token, listing };
}

describe("ArcLaunchpadFactory (Dyor V3 direct)", () => {
  it("launches a token into a live V3 pool at the target market cap", async () => {
    const f = await deployFixture();
    const { token, listing } = await createToken(f);

    expect(listing.creator).to.equal(f.creator.address);
    expect(listing.pool).to.not.equal(ethers.ZeroAddress);
    expect(await f.factory.totalTokens()).to.equal(1n);

    // Effectively the full supply seeds the pool (liquidity floor-rounding
    // can strand sub-wei-scale dust in the factory).
    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);
    const pooled = await erc20.balanceOf(listing.pool);
    expect(pooled).to.be.greaterThan((SUPPLY * 999_999n) / 1_000_000n);
    expect(pooled).to.be.lessThanOrEqual(SUPPLY);

    // Price ~ $3,000 mcap: 3000e6 quote raw / 1e9 tokens.
    const pool = new ethers.Contract(listing.pool, [
      "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
      "function fee() view returns (uint24)",
    ], f.deployer);
    expect(await pool.fee()).to.equal(10_000n);
    const [sqrtP] = await pool.slot0();
    const Q96 = 2n ** 96n;
    // raw price token1/token0
    const p192 = sqrtP * sqrtP;
    const usdAddr = await f.usd.getAddress();
    const tokenIs0 = token.toLowerCase() < usdAddr.toLowerCase();
    // usd-raw per token-wei, scaled 1e24 for precision
    const priceX24 = tokenIs0 ? (p192 * 10n ** 24n) / (Q96 * Q96) : (Q96 * Q96 * 10n ** 24n) / p192;
    const mcapUsdRaw = (priceX24 * SUPPLY) / 10n ** 24n; // quote raw units (6d)
    const mcapUsd = Number(mcapUsdRaw) / 1e6;
    expect(mcapUsd).to.be.greaterThan(2500).and.lessThan(3600);
  });

  it("buys and sells through the router with native in/out", async () => {
    const f = await deployFixture();
    const { token } = await createToken(f);
    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);

    // Buy: 5 native (= 5e6 raw quote after the 1e12 scale).
    const buyValue = ethers.parseEther("5");
    await f.router.connect(f.trader).buy(token, 0, { value: buyValue });
    const bought = await erc20.balanceOf(f.trader.address);
    expect(bought).to.be.greaterThan(0n);
    // ~5 USD at ~$3e-6/token => ~1.6M tokens (1% fee, some slippage).
    expect(Number(ethers.formatEther(bought))).to.be.greaterThan(1_000_000);

    // Slippage guard trips when minOut is absurd.
    await expect(
      f.router.connect(f.trader).buy(token, ethers.parseEther("999999999"), { value: buyValue }),
    ).to.be.revertedWithCustomError(f.router, "SlippageExceeded");

    // Sell half back for native.
    const half = bought / 2n;
    await erc20.connect(f.trader).approve(await f.router.getAddress(), half);
    const nativeBefore = await ethers.provider.getBalance(f.trader.address);
    const tx = await f.router.connect(f.trader).sell(token, half, 0);
    const rc = await tx.wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    const nativeAfter = await ethers.provider.getBalance(f.trader.address);
    expect(nativeAfter + gas).to.be.greaterThan(nativeBefore); // net native received
    expect(await erc20.balanceOf(f.trader.address)).to.equal(bought - half);
  });

  it("splits harvested pool fees 80/20 between creator and platform", async () => {
    const f = await deployFixture();
    const { token } = await createToken(f);
    const usdAddr = await f.usd.getAddress();

    // Generate quote-side fees with a buy.
    await f.router.connect(f.trader).buy(token, 0, { value: ethers.parseEther("50") });

    const creatorBefore = await f.usd.balanceOf(f.creator.address);
    const platformBefore = await f.usd.balanceOf(f.feeRecipient.address);
    await f.factory.connect(f.trader).harvestFees(token); // permissionless
    const creatorGain = (await f.usd.balanceOf(f.creator.address)) - creatorBefore;
    const platformGain = (await f.usd.balanceOf(f.feeRecipient.address)) - platformBefore;

    expect(creatorGain).to.be.greaterThan(0n);
    const total = creatorGain + platformGain;
    expect(creatorGain).to.equal((total * CREATOR_BPS) / BPS);

    // ~1% of 50e6 raw in, ~80% of that to creator.
    expect(Number(total)).to.be.closeTo(0.01 * 50e6, 0.002 * 50e6);

    // Nothing left right after a harvest.
    await expect(f.factory.harvestFees(token)).to.be.revertedWithCustomError(f.factory, "NothingToCollect");
  });

  it("lets the owner collect the position and blocks non-owners", async () => {
    const f = await deployFixture();
    const { token } = await createToken(f);
    await f.router.connect(f.trader).buy(token, 0, { value: ethers.parseEther("10") });

    await expect(f.factory.connect(f.trader).collectFees(token)).to.be.revertedWithCustomError(
      f.factory,
      "OwnableUnauthorizedAccount",
    );

    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);
    const ownerTokenBefore = await erc20.balanceOf(f.owner.address);
    await f.factory.connect(f.owner).collectFees(token);
    expect(await f.factory.positionLiquidity(token)).to.equal(0n);
    expect(await erc20.balanceOf(f.owner.address)).to.be.greaterThan(ownerTokenBefore);
  });

  it("reports pending fees via staticcall and enforces pause/quote rules", async () => {
    const f = await deployFixture();
    const { token } = await createToken(f);
    await f.router.connect(f.trader).buy(token, 0, { value: ethers.parseEther("20") });

    const [tokenFees, quoteFees] = await f.factory.pendingFees.staticCall(token);
    expect(quoteFees).to.be.greaterThan(0n);
    expect(tokenFees).to.equal(0n); // only buys so far; fees accrue in quote

    await f.factory.connect(f.owner).pause();
    await expect(createToken(f)).to.be.revertedWithCustomError(f.factory, "LaunchesArePaused");
    await f.factory.connect(f.owner).resume();

    const rogue = await (await ethers.getContractFactory("MockUSD")).deploy();
    await expect(
      f.factory.connect(f.creator).createToken({ ...PARAMS, quote: await rogue.getAddress(), marketCapUsd8: 0n }),
    ).to.be.revertedWithCustomError(f.factory, "QuoteNotApproved");
  });
});
