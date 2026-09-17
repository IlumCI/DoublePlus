import { expect } from "chai";
import { ethers, network } from "hardhat";

// Curve-phase unit tests: everything up to (but excluding) pool seeding runs
// on the plain hardhat network — the PoolManager is only touched at finalize,
// so a placeholder address is enough here. Pool seeding and post-graduation
// trading are covered by venture.fork.test.ts.

const ETH_USD_8 = 1865n * 10n ** 8n;
const TARGET = ethers.parseEther("2");
const DAY = 86_400;

async function deployStack() {
  const [admin] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  await weth.waitForDeployment();

  // poolManager/v3Router are inert during the curve phase; any code-bearing
  // address that is never called works for these tests. The hook is real so
  // launch() can read its MAX_SIDE_TAX_BPS guardrail (its flags are only
  // checked by the PoolManager, which the curve phase never touches).
  const placeholder = await weth.getAddress();

  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();

  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const hook = await (await ethers.getContractFactory("VentureFeeHook")).deploy(
    placeholder, admin.address, predictedFactory, 100, 2000,
  );
  await hook.waitForDeployment();
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();

  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    admin.address,
    admin.address,
    placeholder, // poolManager (unused pre-finalize)
    await hook.getAddress(),
    await weth.getAddress(),
    placeholder, // v3Router (unused when pair is WETH)
    await vestingDeployer.getAddress(),
    await tokenDeployer.getAddress(),
  );
  await factory.waitForDeployment();
  expect(await factory.getAddress()).to.equal(predictedFactory);
  return { factory, tokenDeployer, weth };
}

async function mineSalt(tokenDeployer: any, args: any[]) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    args,
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, encoded]));
  const depAddr = await tokenDeployer.getAddress();
  for (let i = 0n; i < 6_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(depAddr, s, hash)) & 0xffffn) === 0x4663n) return s;
  }
  throw new Error("no vanity salt");
}

async function launch(
  factory: any,
  tokenDeployer: any,
  creator: any,
  weth: string,
  overrides: Partial<Record<string, any>> = {},
) {
  const params = {
    name: "Venture",
    symbol: "VNT",
    metadataURI: "",
    pair: weth,
    buyTaxBps: 300,
    sellTaxBps: 300,
    devWallet: "0x0000000000000000000000000000000000000000",
    devBps: 2500,
    dividendBps: 2500,
    liquidityBps: 2500,
    mmBps: 2500,
    ethUsdPrice8: ETH_USD_8,
    targetRaiseWei: TARGET,
    raiseDurationSecs: 2 * DAY,
    maxBuyWei: TARGET, // no cap unless the test sets one
    founderRaiseBps: 3000,
    founderSupplyBps: 1000,
    vestingSecs: 180 * DAY,
    v3Path: "0x",
    ...overrides,
  };
  const salt = await mineSalt(tokenDeployer, [
    params.name,
    params.symbol,
    params.metadataURI,
    10n ** 27n,
    creator.address,
    await factory.getAddress(),
    params.buyTaxBps,
    params.pair,
  ]);
  await (await factory.connect(creator).launch(params, salt)).wait();
  return factory.allTokens((await factory.totalTokens()) - 1n);
}

describe("Venture bonding-curve launchpad (unit)", function () {
  this.timeout(300_000);

  it("prices buys by the closed-form integral: inversion is exact-maximal", async () => {
    const [, creator] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());

    // Fuzz the inversion at several curve positions: tokensForValue must
    // return the LARGEST q with curveCost(q) <= value.
    let seed = 0x9e3779b97f4a7c15n;
    const rnd = () => {
      seed ^= seed << 13n; seed &= (1n << 64n) - 1n;
      seed ^= seed >> 7n;
      seed ^= seed << 17n; seed &= (1n << 64n) - 1n;
      return seed;
    };
    const state = await factory.curveState(coin);
    for (let i = 0; i < 60; i++) {
      const value = (rnd() % ethers.parseEther("0.05")) + 10n ** 12n;
      const sold = (await factory.curveState(coin)).soldWhole;
      const q = await factory.tokensForValue(coin, value);
      if (q > 0n) {
        expect(await factory.curveCost(coin, q, sold)).to.be.lessThanOrEqual(value);
      }
      expect(await factory.curveCost(coin, q + 1n, sold)).to.be.greaterThan(value);
      if (i % 7 === 0 && state.raisedWei < TARGET / 2n) {
        await (await factory.connect(creator).buy(coin, { value: ethers.parseEther("0.01") })).wait();
      }
    }
  });

  it("is path-independent: one spend equals the same spend split up", async () => {
    const [, creatorA, creatorB, buyer] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const wethAddr = await weth.getAddress();
    const coinA = await launch(factory, tokenDeployer, creatorA, wethAddr);
    const coinB = await launch(factory, tokenDeployer, creatorB, wethAddr, { symbol: "VNT2" });

    // Same total spend: 1 x 0.8 ETH on curve A, 8 x 0.1 ETH on curve B.
    await (await factory.connect(buyer).buy(coinA, { value: ethers.parseEther("0.8") })).wait();
    for (let i = 0; i < 8; i++) {
      await (await factory.connect(buyer).buy(coinB, { value: ethers.parseEther("0.1") })).wait();
    }
    const gotA = await (await ethers.getContractAt("QuiverToken", coinA)).balanceOf(buyer.address);
    const gotB = await (await ethers.getContractAt("QuiverToken", coinB)).balanceOf(buyer.address);
    // Whole-token flooring costs at most 1 token per transaction.
    const diff = gotA > gotB ? gotA - gotB : gotB - gotA;
    expect(diff, "order splitting must not change the outcome").to.be.lessThanOrEqual(ethers.parseEther("8"));
    // Whole-token flooring means splitting can never gain more than the dust.
    expect(gotB, "splitting never gains").to.be.lessThanOrEqual(gotA + ethers.parseEther("1"));
  });

  it("enforces the per-wallet cap", async () => {
    const [, creator, buyer] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      maxBuyWei: TARGET / 100n,
    });
    await (await factory.connect(buyer).buy(coin, { value: TARGET / 100n - 10n ** 9n })).wait();
    await expect(factory.connect(buyer).buy(coin, { value: TARGET / 100n })).to.be.revertedWithCustomError(
      factory,
      "CapExceeded",
    );
  });

  it("escrows the founder allocation and rejects bad terms", async () => {
    const [, creator] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const wethAddr = await weth.getAddress();
    const coin = await launch(factory, tokenDeployer, creator, wethAddr);

    const vesting = await factory.vestingOf(coin);
    expect(vesting).to.not.equal(ethers.ZeroAddress);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    expect(await erc.balanceOf(vesting), "10% escrowed").to.equal(10n ** 26n);
    const esc = await ethers.getContractAt("FounderVesting", vesting);
    expect(await esc.beneficiary()).to.equal(creator.address);
    await expect(esc.connect(creator).claim()).to.be.revertedWithCustomError(esc, "NotStarted");

    // Terms outside the guardrails are rejected.
    for (const bad of [
      { founderRaiseBps: 3001 },
      { founderSupplyBps: 1501, symbol: "X1" },
      { founderSupplyBps: 500, vestingSecs: 89 * DAY, symbol: "X2" },
      { raiseDurationSecs: DAY / 2, symbol: "X3" },
      { targetRaiseWei: ethers.parseEther("0.5"), symbol: "X4" }, // below p0*C
      { maxBuyWei: TARGET / 500n, symbol: "X5" }, // cap makes raise impossible
      { buyTaxBps: 401, symbol: "X6" }, // over the 4% per-side ceiling
      { sellTaxBps: 500, symbol: "X7" },
      { devBps: 3000, symbol: "X8" }, // buckets no longer sum to 100%
    ]) {
      await expect(launch(factory, tokenDeployer, creator, wethAddr, bad)).to.be.revertedWithCustomError(
        factory,
        "InvalidParams",
      );
    }
  });

  it("aborts a dead raise and refunds buyers in full", async () => {
    const [, creator, buyer1, buyer2] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());
    const erc = await ethers.getContractAt("QuiverToken", coin);

    await (await factory.connect(buyer1).buy(coin, { value: ethers.parseEther("0.3") })).wait();
    await (await factory.connect(buyer2).buy(coin, { value: ethers.parseEther("0.2") })).wait();
    const spent1 = await factory.spentWei(coin, buyer1.address);
    expect(spent1).to.be.greaterThan(0n);

    // Not abortable while live; not finalizable below target.
    await expect(factory.abort(coin)).to.be.revertedWithCustomError(factory, "CurveLive");
    await expect(factory.finalize(coin)).to.be.revertedWithCustomError(factory, "CurveLive");

    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await expect(factory.connect(buyer1).buy(coin, { value: 10n ** 15n })).to.be.revertedWithCustomError(
      factory,
      "CurveClosed",
    );

    const supplyBefore = await erc.totalSupply();
    await (await factory.abort(coin)).wait();
    // Factory inventory + the reclaimed founder escrow burned.
    expect(await erc.balanceOf(await factory.getAddress())).to.equal(0n);
    expect(await erc.balanceOf(await factory.vestingOf(coin))).to.equal(0n);
    expect(await erc.totalSupply()).to.be.lessThan(supplyBefore);

    // Full refund against returning the tokens.
    const bought = await erc.balanceOf(buyer1.address);
    await (await erc.connect(buyer1).approve(await factory.getAddress(), bought)).wait();
    const balBefore = await ethers.provider.getBalance(buyer1.address);
    const rc = await (await factory.connect(buyer1).refund(coin)).wait();
    const gas = rc!.gasUsed * rc!.gasPrice;
    expect((await ethers.provider.getBalance(buyer1.address)) - balBefore + gas).to.equal(spent1);
    expect(await erc.balanceOf(buyer1.address)).to.equal(0n);
    await expect(factory.connect(buyer1).refund(coin)).to.be.revertedWithCustomError(factory, "NothingToRefund");
  });

  it("refunds are bounded by the raise's own escrow and cannot reach a sibling raise", async () => {
    const [, creatorA, buyer1, buyer2, creatorB, buyer3] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const wethAddr = await weth.getAddress();
    const factoryAddr = await factory.getAddress();

    // Two concurrent raises sharing one factory balance. B outlives A.
    const coinA = await launch(factory, tokenDeployer, creatorA, wethAddr);
    const coinB = await launch(factory, tokenDeployer, creatorB, wethAddr, {
      raiseDurationSecs: 14 * DAY,
    });
    const ercA = await ethers.getContractAt("QuiverToken", coinA);

    await (await factory.connect(buyer1).buy(coinA, { value: ethers.parseEther("0.35") })).wait();
    await (await factory.connect(buyer2).buy(coinA, { value: ethers.parseEther("0.22") })).wait();
    await (await factory.connect(buyer3).buy(coinB, { value: ethers.parseEther("0.41") })).wait();

    const raisedA = (await factory.curveState(coinA)).raisedWei;
    const raisedB = (await factory.curveState(coinB)).raisedWei;
    // Every wei the factory holds is escrow attributable to one of the raises.
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(raisedA + raisedB);

    // Per-user ledgers sum to exactly that raise's total.
    const spent1 = await factory.spentWei(coinA, buyer1.address);
    const spent2 = await factory.spentWei(coinA, buyer2.address);
    expect(spent1 + spent2).to.equal(raisedA);

    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coinA)).wait();

    // B is untouched by A's failure: still live, still unrefundable.
    await expect(factory.abort(coinB)).to.be.revertedWithCustomError(factory, "CurveLive");
    await expect(factory.connect(buyer3).refund(coinB)).to.be.revertedWithCustomError(factory, "NotAborted");

    // A buyer of B has no claim on A's escrow.
    await expect(factory.connect(buyer3).refund(coinA)).to.be.revertedWithCustomError(
      factory,
      "NothingToRefund",
    );

    let paidOut = 0n;
    for (const [buyer, spent] of [[buyer1, spent1], [buyer2, spent2]] as const) {
      const bal = await ercA.balanceOf(buyer.address);
      await (await ercA.connect(buyer).approve(factoryAddr, bal)).wait();
      const before = await ethers.provider.getBalance(buyer.address);
      const rc = await (await factory.connect(buyer).refund(coinA)).wait();
      const got = (await ethers.provider.getBalance(buyer.address)) - before + rc!.gasUsed * rc!.gasPrice;
      expect(got).to.equal(spent);
      paidOut += got;
      // Second attempt pays nothing, even holding tokens bought elsewhere.
      await expect(factory.connect(buyer).refund(coinA)).to.be.revertedWithCustomError(
        factory,
        "NothingToRefund",
      );
    }

    // The aborted raise paid out exactly what it took in, and B's escrow is intact.
    expect(paidOut).to.equal(raisedA);
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(raisedB);
  });

  it("never books spend it cannot refund: a buy too small to mint reverts", async () => {
    const [, creator, buyer1] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());

    // Below the cost of one whole token the quote rounds to zero. The buy must
    // revert rather than credit spentWei against zero tokens, which would
    // strand the ETH: refund() requires both sides to be non-zero.
    await expect(factory.connect(buyer1).buy(coin, { value: 1n })).to.be.revertedWithCustomError(
      factory,
      "InvalidParams",
    );
    expect(await factory.spentWei(coin, buyer1.address)).to.equal(0n);
  });
});
