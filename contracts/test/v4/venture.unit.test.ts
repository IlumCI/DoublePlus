import { expect } from "chai";
import { ethers, network } from "hardhat";

// Curve-phase unit tests: everything up to (but excluding) pool seeding runs
// on the plain hardhat network — the PoolManager is only touched at finalize,
// so a placeholder address is enough here. Pool seeding and post-graduation
// trading are covered by venture.fork.test.ts.

import { DAY, deployStack, launch, mineSalt, TARGET } from "./helpers/venture";

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
      // Below p0*C: the whole curve supply at the start price costs 0.2413 ETH
      // at the $750 start valuation, so a target under that needs a downward
      // slope. Tracks START_MCAP_USD_8 — see venture.lock.test.ts.
      { targetRaiseWei: ethers.parseEther("0.2"), symbol: "X4" },
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
    // Every wei the factory holds is either escrow attributable to one of the
    // raises or a curve fee waiting to be withdrawn. Nothing else.
    const [admin] = await ethers.getSigners();
    const fees = () => factory.feesAccrued(admin.address);
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(raisedA + raisedB + (await fees()));

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
    expect((await factory.curveState(coinA)).raisedWei).to.equal(0n);
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(raisedB + (await fees()));
  });

  it("charges the entry fee on the way in and books only what reaches escrow", async () => {
    const [admin, creator, buyer1] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());

    const sent = ethers.parseEther("0.4");
    await (await factory.connect(buyer1).buy(coin, { value: sent })).wait();

    const fee = (sent * 50n) / 10_000n; // curveBuyFeeBps = 50
    expect(await factory.feesAccrued(admin.address)).to.equal(fee);

    // spentWei is net of the fee, and the curve total equals the per-user sum.
    const spent = await factory.spentWei(coin, buyer1.address);
    expect(spent).to.be.lessThanOrEqual(sent - fee);
    expect((await factory.curveState(coin)).raisedWei).to.equal(spent);

    // Fees are pull-payment: nothing was sent to the treasury in the trade path.
    const before = await ethers.provider.getBalance(admin.address);
    const rc = await (await factory.withdrawFees()).wait();
    const got = (await ethers.provider.getBalance(admin.address)) - before + rc!.gasUsed * rc!.gasPrice;
    expect(got).to.equal(fee);
    expect(await factory.feesAccrued(admin.address)).to.equal(0n);
  });

  it("sells back to the curve, caps the payout at cost basis, and stays solvent", async () => {
    const [admin, creator, buyer1, buyer2] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const factoryAddr = await factory.getAddress();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());
    const erc = await ethers.getContractAt("QuiverToken", coin);

    // buyer1 in first and cheapest, buyer2 pushes the curve up behind them.
    await (await factory.connect(buyer1).buy(coin, { value: ethers.parseEther("0.2") })).wait();
    await (await factory.connect(buyer2).buy(coin, { value: ethers.parseEther("0.5") })).wait();

    const basis = await factory.spentWei(coin, buyer1.address);
    const held = await erc.balanceOf(buyer1.address);
    const half = held / 2n / 10n ** 18n;

    await (await erc.connect(buyer1).approve(factoryAddr, held)).wait();
    const before = await ethers.provider.getBalance(buyer1.address);
    const rc = await (await factory.connect(buyer1).sell(coin, half, 0)).wait();
    const out = (await ethers.provider.getBalance(buyer1.address)) - before + rc!.gasUsed * rc!.gasPrice;

    // The curve owes buyer1 more than they paid, but Guaranteed mode caps the
    // gross at their pro-rata cost basis; the 1% sell fee comes out of that.
    const tokenWei = half * 10n ** 18n;
    const grossCap = (basis * tokenWei) / held;
    expect(out).to.equal(grossCap - (grossCap * 100n) / 10_000n);

    // Ledgers move together: the tokens sold and the basis behind them.
    expect(await factory.spentWei(coin, buyer1.address)).to.equal(basis - grossCap);
    expect(await erc.balanceOf(buyer1.address)).to.equal(held - tokenWei);

    // Solvency: escrow still covers every remaining claim, exactly.
    const claims =
      (await factory.spentWei(coin, buyer1.address)) + (await factory.spentWei(coin, buyer2.address));
    const raised = (await factory.curveState(coin)).raisedWei;
    expect(raised).to.equal(claims);
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(
      raised + (await factory.feesAccrued(admin.address)),
    );

    // And the refund path still pays those claims in full after an abort.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coin)).wait();
    let paid = 0n;
    for (const b of [buyer1, buyer2]) {
      const bal = await erc.balanceOf(b.address);
      await (await erc.connect(b).approve(factoryAddr, bal)).wait();
      const pre = await ethers.provider.getBalance(b.address);
      const r = await (await factory.connect(b).refund(coin)).wait();
      paid += (await ethers.provider.getBalance(b.address)) - pre + r!.gasUsed * r!.gasPrice;
    }
    expect(paid).to.equal(claims);
    expect((await factory.curveState(coin)).raisedWei).to.equal(0n);
  });

  it("freezes the curve both ways once the graduation trigger is crossed", async () => {
    const [, creator, buyer1] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      maxBuyWei: ethers.parseEther("10"),
    });
    const erc = await ethers.getContractAt("QuiverToken", coin);

    await (await factory.connect(buyer1).buy(coin, { value: ethers.parseEther("2.4") })).wait();
    expect((await factory.curveState(coin)).raisedWei).to.be.greaterThanOrEqual(TARGET);

    // A sell here could drag a funded raise back under target and make it
    // abortable, so the lock has to close both directions, not just buys.
    const held = await erc.balanceOf(buyer1.address);
    await (await erc.connect(buyer1).approve(await factory.getAddress(), held)).wait();
    await expect(factory.connect(buyer1).sell(coin, 1000n, 0)).to.be.revertedWithCustomError(
      factory,
      "CurveClosed",
    );
    await expect(
      factory.connect(buyer1).buy(coin, { value: 10n ** 15n }),
    ).to.be.revertedWithCustomError(factory, "CurveClosed");

    // Frozen above target, abort can never fire.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await expect(factory.abort(coin)).to.be.revertedWithCustomError(factory, "CurveLive");
  });

  it("open mode: no deadline, no founder cut, uncapped sells, creator earns curve fees", async () => {
    const [admin, creator, buyer1, buyer2] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const wethAddr = await weth.getAddress();
    const factoryAddr = await factory.getAddress();
    await (await factory.setParams(0, ethers.parseEther("4"), 365 * DAY, 1000)).wait();

    // An open curve pays its creator out of fees, so it cannot also take a cut
    // of a raise it does not have.
    await expect(
      launch(factory, tokenDeployer, creator, wethAddr, { mode: 1, founderRaiseBps: 1000 }),
    ).to.be.revertedWithCustomError(factory, "InvalidParams");

    const coin = await launch(factory, tokenDeployer, creator, wethAddr, {
      mode: 1,
      founderRaiseBps: 0,
      maxBuyWei: ethers.parseEther("10"),
    });
    const erc = await ethers.getContractAt("QuiverToken", coin);
    expect((await factory.curveState(coin)).targetRaiseWei).to.equal(ethers.parseEther("4"));

    await (await factory.connect(buyer1).buy(coin, { value: ethers.parseEther("0.3") })).wait();

    // No deadline: the curve is still open long past any raise window.
    await network.provider.send("evm_increaseTime", [60 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.connect(buyer2).buy(coin, { value: ethers.parseEther("1.2") })).wait();
    await expect(factory.abort(coin)).to.be.revertedWithCustomError(factory, "CurveLive");

    // buyer1 bought lowest and may leave at a profit — no cost-basis cap here.
    const basis = await factory.spentWei(coin, buyer1.address);
    const held = await erc.balanceOf(buyer1.address);
    await (await erc.connect(buyer1).approve(factoryAddr, held)).wait();
    const pre = await ethers.provider.getBalance(buyer1.address);
    const rc = await (await factory.connect(buyer1).sell(coin, held / 10n ** 18n, 0)).wait();
    const out = (await ethers.provider.getBalance(buyer1.address)) - pre + rc!.gasUsed * rc!.gasPrice;
    expect(out).to.be.greaterThan(basis);

    // The creator takes their share of that sell fee; the rest is the protocol's.
    expect(await factory.feesAccrued(creator.address)).to.be.greaterThan(0n);
    expect(await factory.feesAccrued(admin.address)).to.be.greaterThan(
      await factory.feesAccrued(creator.address),
    );
    expect(await ethers.provider.getBalance(factoryAddr)).to.equal(
      (await factory.curveState(coin)).raisedWei +
        (await factory.feesAccrued(admin.address)) +
        (await factory.feesAccrued(creator.address)),
    );
  });

  it("takes a creation fee, and sweeps abandoned escrow only after the delay", async () => {
    const [admin, creator, buyer1] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const creationFee = ethers.parseEther("0.01");
    await (await factory.setParams(creationFee, ethers.parseEther("5"), 180 * DAY, 1000)).wait();

    await expect(
      launch(factory, tokenDeployer, creator, await weth.getAddress(), {}, 0n),
    ).to.be.revertedWithCustomError(factory, "InvalidParams");

    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {}, creationFee);
    expect(await factory.feesAccrued(admin.address)).to.equal(creationFee);

    await (await factory.connect(buyer1).buy(coin, { value: ethers.parseEther("0.2") })).wait();
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coin)).wait();

    await expect(factory.sweepUnclaimed(coin)).to.be.revertedWithCustomError(factory, "SweepTooEarly");

    await network.provider.send("evm_increaseTime", [181 * DAY]);
    await network.provider.send("evm_mine");
    const left = (await factory.curveState(coin)).raisedWei;
    const feesBefore = await factory.feesAccrued(admin.address);
    await (await factory.sweepUnclaimed(coin)).wait();
    expect(await factory.feesAccrued(admin.address)).to.equal(feesBefore + left);

    // Once swept the raise is closed for good; a late claimant cannot reach
    // into another raise's escrow to be made whole.
    await expect(factory.sweepUnclaimed(coin)).to.be.revertedWithCustomError(factory, "AlreadySwept");
    await expect(factory.connect(buyer1).refund(coin)).to.be.revertedWithCustomError(
      factory,
      "AlreadySwept",
    );
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
