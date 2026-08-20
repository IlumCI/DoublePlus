import { expect } from "chai";
import { ethers } from "hardhat";

import UniswapV3FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import SwapRouterArtifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
import PositionManagerArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * StableLaunchpadFactory integration tests against the REAL Uniswap V3
 * bytecode (factory, position manager, SwapRouter02) — the same stack the
 * official Stable Mainnet deployment runs. The wrapped native stands in for
 * WUSDT0 ($1.00), and trading happens directly on the official router, never
 * through the launchpad.
 */

const SUPPLY = ethers.parseEther("1000000000");
const DEFAULT_MCAP_USD8 = 3_000n * 10n ** 8n;
const BPS = 10_000n;
const CREATOR_BPS = 8_000n;
const DEADLINE = 4_000_000_000n;

async function deployFixture() {
  const [deployer, owner, feeRecipient, creator, trader] = await ethers.getSigners();

  // Wrapped native: WUSDT0 — the native currency on Stable is a dollar.
  const wnative = await (await ethers.getContractFactory("WrappedNative")).deploy("Wrapped USDT0", "WUSDT0");

  const uniFactory = await new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    deployer,
  ).deploy();

  const positionManager = await new ethers.ContractFactory(
    PositionManagerArtifact.abi,
    PositionManagerArtifact.bytecode,
    deployer,
  ).deploy(await uniFactory.getAddress(), await wnative.getAddress(), ethers.ZeroAddress);

  const swapRouter = await new ethers.ContractFactory(
    SwapRouterArtifact.abi,
    SwapRouterArtifact.bytecode,
    deployer,
  ).deploy(ethers.ZeroAddress, await uniFactory.getAddress(), await positionManager.getAddress(), await wnative.getAddress());

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).deploy();

  const factory = await (await ethers.getContractFactory("StableLaunchpadFactory")).deploy(
    owner.address,
    feeRecipient.address,
    await tokenDeployer.getAddress(),
    await uniFactory.getAddress(),
    await positionManager.getAddress(),
    await swapRouter.getAddress(),
    await wnative.getAddress(),
  );
  await tokenDeployer.setFactory(await factory.getAddress());

  return { deployer, owner, feeRecipient, creator, trader, wnative, uniFactory, positionManager, swapRouter, tokenDeployer, factory };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

const PARAMS = {
  name: "Steady Token",
  symbol: "STDY",
  metadataURI: JSON.stringify({ description: "test" }),
};

async function createToken(f: Fixture, marketCapUsd8 = 0n, quote?: string) {
  const p = { ...PARAMS, quote: quote ?? (await f.wnative.getAddress()), marketCapUsd8 };
  const tx = await f.factory.connect(f.creator).createToken(p);
  const rc = await tx.wait();
  const ev = rc!.logs
    .map((l: any) => {
      try {
        return f.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((x: any) => x?.name === "TokenCreated");
  return ev!.args.token as string;
}

async function buyOnRouter(f: Fixture, token: string, amountInNative: bigint) {
  // Trading happens directly on the official SwapRouter — wrap, approve, swap.
  await (await f.wnative.connect(f.trader).deposit({ value: amountInNative })).wait();
  await (await f.wnative.connect(f.trader).approve(await f.swapRouter.getAddress(), amountInNative)).wait();
  const router = new ethers.Contract(await f.swapRouter.getAddress(), SwapRouterArtifact.abi, f.trader);
  await (
    await router.exactInputSingle({
      tokenIn: await f.wnative.getAddress(),
      tokenOut: token,
      fee: 10_000,
      recipient: f.trader.address,
      amountIn: amountInNative,
      amountOutMinimum: 0,
      sqrtPriceLimitX96: 0,
    })
  ).wait();
}

describe("StableLaunchpadFactory (real Uniswap V3)", function () {
  this.timeout(300_000);

  it("launches at the $3,000 default market cap with the full supply single-sided", async () => {
    const f = await deployFixture();
    const token = await createToken(f);

    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);
    expect(await erc20.totalSupply()).to.equal(SUPPLY);
    expect(await erc20.owner()).to.equal(ethers.ZeroAddress); // immutable from birth
    expect(await erc20.creator()).to.equal(f.creator.address);

    // Live pool market cap ≈ $3,000 (tick snapping allows small drift).
    const mcap = await f.factory.marketCapUsd(token);
    expect(mcap).to.be.greaterThan((DEFAULT_MCAP_USD8 * 90n) / 100n);
    expect(mcap).to.be.lessThan((DEFAULT_MCAP_USD8 * 110n) / 100n);

    // LP NFT custodied by the factory.
    const positionId = await f.factory.positionOf(token);
    const pm = new ethers.Contract(await f.positionManager.getAddress(), PositionManagerArtifact.abi, f.deployer);
    expect(await pm.ownerOf(positionId)).to.equal(await f.factory.getAddress());
  });

  it("honors a creator-selected market cap", async () => {
    const f = await deployFixture();
    const token = await createToken(f, 10_000n * 10n ** 8n);
    const mcap = await f.factory.marketCapUsd(token);
    expect(mcap).to.be.greaterThan(9_000n * 10n ** 8n);
    expect(mcap).to.be.lessThan(11_000n * 10n ** 8n);
  });

  it("rejects out-of-range market caps, bad quotes and paused launches", async () => {
    const f = await deployFixture();
    const wq = await f.wnative.getAddress();

    await expect(
      f.factory.connect(f.creator).createToken({ ...PARAMS, quote: wq, marketCapUsd8: 1n }),
    ).to.be.revertedWithCustomError(f.factory, "MarketCapOutOfRange");
    await expect(
      f.factory.connect(f.creator).createToken({ ...PARAMS, quote: f.creator.address, marketCapUsd8: 0n }),
    ).to.be.revertedWithCustomError(f.factory, "QuoteNotApproved");

    await (await f.factory.connect(f.owner).pause()).wait();
    await expect(
      f.factory.connect(f.creator).createToken({ ...PARAMS, quote: wq, marketCapUsd8: 0n }),
    ).to.be.revertedWithCustomError(f.factory, "LaunchesArePaused");
    await (await f.factory.connect(f.owner).resume()).wait();
    await createToken(f); // works again
  });

  it("trades on the official router and harvests fees 80/20 creator/platform", async () => {
    const f = await deployFixture();
    const token = await createToken(f);
    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);

    await buyOnRouter(f, token, ethers.parseEther("50"));
    expect(await erc20.balanceOf(f.trader.address)).to.be.greaterThan(0n);

    const wq = await f.wnative.getAddress();
    const creatorBefore = await f.wnative.balanceOf(f.creator.address);
    const platformBefore = await f.wnative.balanceOf(f.feeRecipient.address);

    await (await f.factory.harvestFees(token)).wait();

    const creatorGain = (await f.wnative.balanceOf(f.creator.address)) - creatorBefore;
    const platformGain = (await f.wnative.balanceOf(f.feeRecipient.address)) - platformBefore;
    expect(creatorGain, "creator earns quote-side pool fees").to.be.greaterThan(0n);
    // 80/20 split, exact in integer math: platform = total - creator share.
    const total = creatorGain + platformGain;
    expect(creatorGain).to.equal((total * CREATOR_BPS) / BPS);

    // Nothing left to harvest right away.
    await expect(f.factory.harvestFees(token)).to.be.revertedWithCustomError(f.factory, "NothingToCollect");
  });

  it("collectFees is owner-only and unwinds the whole position to the owner", async () => {
    const f = await deployFixture();
    const token = await createToken(f);
    await buyOnRouter(f, token, ethers.parseEther("20"));

    await expect(f.factory.connect(f.creator).collectFees(token)).to.be.revertedWithCustomError(
      f.factory,
      "OwnableUnauthorizedAccount",
    );

    const erc20 = await ethers.getContractAt("LaunchpadERC20", token);
    const ownerTokenBefore = await erc20.balanceOf(f.owner.address);
    const ownerQuoteBefore = await f.wnative.balanceOf(f.owner.address);

    await (await f.factory.connect(f.owner).collectFees(token)).wait();

    expect(await erc20.balanceOf(f.owner.address)).to.be.greaterThan(ownerTokenBefore);
    expect(await f.wnative.balanceOf(f.owner.address)).to.be.greaterThan(ownerQuoteBefore);

    const info = await f.factory.poolInfo(token);
    expect(info.positionLiquidity).to.equal(0n);
  });

  it("supports an approved 6-decimal stablecoin as the quote asset", async () => {
    const f = await deployFixture();
    const usd = await (await ethers.getContractFactory("MockUSD")).deploy();
    const usdAddr = await usd.getAddress();
    await (await f.factory.connect(f.owner).setQuoteAsset(usdAddr, true, 100_000_000n)).wait();

    const token = await createToken(f, 0n, usdAddr);
    const mcap = await f.factory.marketCapUsd(token);
    expect(mcap).to.be.greaterThan((DEFAULT_MCAP_USD8 * 90n) / 100n);
    expect(mcap).to.be.lessThan((DEFAULT_MCAP_USD8 * 110n) / 100n);
  });

  it("owner configuration and recovery paths work; others are locked out", async () => {
    const f = await deployFixture();

    await expect(f.factory.connect(f.creator).pause()).to.be.revertedWithCustomError(
      f.factory,
      "OwnableUnauthorizedAccount",
    );
    await expect(
      f.factory.connect(f.creator).setFeeRecipient(f.creator.address),
    ).to.be.revertedWithCustomError(f.factory, "OwnableUnauthorizedAccount");

    await expect(f.factory.connect(f.owner).setFeeRecipient(f.trader.address))
      .to.emit(f.factory, "FeeRecipientUpdated")
      .withArgs(f.feeRecipient.address, f.trader.address);

    // ERC20 recovery: send a stray token in, owner pulls it out.
    const usd = await (await ethers.getContractFactory("MockUSD")).deploy();
    await (await usd.transfer(await f.factory.getAddress(), 5_000_000n)).wait();
    await (await f.factory.connect(f.owner).recoverERC20(await usd.getAddress(), 5_000_000n)).wait();
    expect(await usd.balanceOf(f.owner.address)).to.equal(5_000_000n);

    // Native recovery — balance delta must equal the recovered amount less gas.
    const stray = ethers.parseEther("1");
    await f.deployer.sendTransaction({ to: await f.factory.getAddress(), value: stray });
    const before = await ethers.provider.getBalance(f.owner.address);
    const rc = await (await f.factory.connect(f.owner).recoverNative()).wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect(await ethers.provider.getBalance(f.owner.address)).to.equal(before + stray - gas);
    expect(await ethers.provider.getBalance(await f.factory.getAddress())).to.equal(0n);
  });
});
