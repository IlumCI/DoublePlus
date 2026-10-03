import { expect } from "chai";
import { ethers } from "hardhat";

// The two promises the site makes in plain words, asserted against the
// contract rather than the copy: graduated liquidity has no way out, and no
// raise finishes below the platform's floor.

import { deployStack, launch, TARGET, ETH_USD_MIN_8, ETH_USD_MAX_8 } from "./helpers/venture";

describe("VentureFactory: locked liquidity and the raise floor", function () {
  this.timeout(300_000);

  describe("liquidity is locked because nothing can unlock it", () => {
    it("exposes no function that can withdraw pool liquidity", async () => {
      const { factory } = await deployStack();
      const names = factory.interface.fragments
        .filter((f: any) => f.type === "function")
        .map((f: any) => f.name);

      // `collect` was the disclosed admin recovery lever. On the copair
      // factory it was used to pull 100% of a live pool eleven hours after
      // launch; that is the outcome this assertion exists to prevent.
      for (const banned of ["collect", "unwindPosition", "removeLiquidity", "rescue", "sweepPool"]) {
        expect(names, `${banned}() must not exist`).to.not.include(banned);
      }
      // Nothing may take a pool balance out of the PoolManager either.
      expect(names.some((n: string) => /take|withdrawLp|pullLiquidity/i.test(n))).to.equal(false);
    });

    it("has no protocol-admin function that touches a pool", async () => {
      const { factory } = await deployStack();
      // The admin surface should be configuration only: pause, resume, params.
      const adminish = factory.interface.fragments
        .filter((f: any) => f.type === "function" && f.stateMutability !== "view" && f.stateMutability !== "pure")
        .map((f: any) => f.name)
        .filter((n: string) => !["launch", "buy", "sell", "refund", "finalize", "abort", "withdrawFees",
                                 "sweepUnclaimed", "unlockCallback", "renounceOwnership", "transferOwnership",
                                 "claimFees"].includes(n));
      expect(adminish.sort()).to.deep.equal(["pause", "resume", "setParams"]);
    });

    it("rejects an unlockCallback from anyone but the PoolManager", async () => {
      const [, stranger] = await ethers.getSigners();
      const { factory } = await deployStack();
      // The callback is the only code path that moves liquidity at all, and
      // it now only ever adds. An outsider cannot reach it regardless.
      await expect(
        factory.connect(stranger).unlockCallback(
          ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [0]),
        ),
      ).to.be.revertedWithCustomError(factory, "NotPoolManager");
    });

    it("still records what was locked, so the lock is publicly verifiable", async () => {
      const { factory } = await deployStack();
      expect(factory.interface.getFunction("tokenPositions")).to.not.equal(null);
      expect(factory.interface.getFunction("pairPositions")).to.not.equal(null);
    });
  });

  describe("no raise finishes below the floor", () => {
    // The shipped floor. At the $750 start valuation the curve's own base cost
    // is 0.241 ETH at $1,865/ETH, so this floor is the binding constraint and
    // these tests exercise it rather than the curve-slope guard.
    const FLOOR = ethers.parseEther("0.5");

    it("refuses a founder target below the floor and accepts one at it", async () => {
      const [, creator] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack(FLOOR);
      const w = await weth.getAddress();

      await expect(
        launch(factory, tokenDeployer, creator, w, {
          targetRaiseWei: FLOOR - 1n, maxBuyWei: FLOOR, founderRaiseBps: 0,
        }),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");

      // Exactly at the floor is allowed: the floor is a minimum, not a gap.
      const coin = await launch(factory, tokenDeployer, creator, w, {
        targetRaiseWei: FLOOR, maxBuyWei: FLOOR, founderRaiseBps: 0,
        name: "AtFloor", symbol: "ATF",
      });
      expect((await factory.curveState(coin)).targetRaiseWei).to.equal(FLOOR);
    });

    it("binds the floor to pool depth, not the headline raise", async () => {
      // The floor exists to guarantee a tradeable pool. finalize() pays the
      // founder's cut first and seeds the pool with what is left, so a floor
      // checked against the gross let a floor-sized raise with the maximum 30%
      // cut graduate into 0.35 ETH — against an interface offering a 1 ETH
      // quick-buy. The floor now binds the remainder.
      const [, creator] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack(FLOOR);
      const w = await weth.getAddress();
      const CUT = 3000n; // 30%, the maximum

      // A floor-sized raise that would net only 70% of the floor: rejected.
      await expect(
        launch(factory, tokenDeployer, creator, w, {
          targetRaiseWei: FLOOR, maxBuyWei: FLOOR, founderRaiseBps: Number(CUT),
        }),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");

      // Grossed up so the remainder is exactly the floor: accepted.
      const grossed = (FLOOR * 10_000n) / (10_000n - CUT);
      expect(grossed - (grossed * CUT) / 10_000n).to.equal(FLOOR); // net is exact
      const coin = await launch(factory, tokenDeployer, creator, w, {
        targetRaiseWei: grossed, maxBuyWei: grossed, founderRaiseBps: Number(CUT),
        name: "NetFloor", symbol: "NTF",
      });
      expect((await factory.curveState(coin)).targetRaiseWei).to.equal(grossed);

      // One wei under that gross nets one wei under the floor: rejected.
      await expect(
        launch(factory, tokenDeployer, creator, w, {
          targetRaiseWei: grossed - 1n, maxBuyWei: grossed, founderRaiseBps: Number(CUT),
          name: "JustUnder", symbol: "JUS",
        }),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("is still bounded below by what the curve's own start price costs", async () => {
      // The floor and START_MCAP_USD_8 are coupled. The curve sells
      // CURVE_SUPPLY_WHOLE tokens starting at a fixed USD valuation of the
      // whole supply, and the price only ever rises, so the cheapest raise
      // that can exist is the whole curve supply bought at the START price:
      //
      //   baseCost = START_MCAP_USD_8 * (CURVE/TOTAL) / ethUsd
      //            = $750 * 0.6 / $1,865 = 0.2413 ETH
      //
      // A target under that needs k < 0 — a curve sloping DOWN — and launch()
      // rejects it however low minTargetWei is set. That is why raising the
      // start valuation raises the smallest launchable raise with it: at
      // $3,000 this came to 0.9651 ETH, which put a 0.5 ETH floor out of
      // reach entirely. This test pins the relationship so a future change to
      // either number cannot silently strand the other.
      const [, creator] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack(1n); // floor out of the way
      const belowBaseCost = ethers.parseEther("0.2"); // < 0.2413
      await expect(
        launch(factory, tokenDeployer, creator, await weth.getAddress(), {
          targetRaiseWei: belowBaseCost, maxBuyWei: belowBaseCost,
        }),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
    });

    it("applies the floor to open-mode raises too, via the graduation trigger", async () => {
      const { factory } = await deployStack(FLOOR);
      expect(await factory.minTargetWei()).to.equal(FLOOR);
      // The shipped default trigger is 4 ETH, and never below the floor.
      expect(await factory.graduationRaiseWei()).to.equal(ethers.parseEther("4"));
      const { factory: high } = await deployStack(ethers.parseEther("5"));
      expect(await high.graduationRaiseWei()).to.equal(ethers.parseEther("5"));
    });

    it("will not let the admin move the graduation trigger below the floor", async () => {
      const [admin] = await ethers.getSigners();
      const { factory } = await deployStack(FLOOR);
      await expect(
        factory.connect(admin).setParams(0, FLOOR - 1n, 365 * 86_400, 1_000),
      ).to.be.revertedWithCustomError(factory, "InvalidParams");
      await (await factory.connect(admin).setParams(0, FLOOR * 2n, 365 * 86_400, 1_000)).wait();
      expect(await factory.graduationRaiseWei()).to.equal(FLOOR * 2n);
    });

    it("cannot be deployed with a zero floor", async () => {
      await expect(deployStack(0n)).to.be.reverted;
    });
  });

  describe("a launcher cannot price their own curve's start", () => {
    // ethUsdPrice8 sizes the start price and is caller-supplied (no oracle in
    // the launch path). Unbounded, a launcher passes an absurd price, opens
    // the curve near zero and buys the cheap end first. The band is immutable.
    it("rejects an ETH/USD price outside the deployed band", async () => {
      const [, creator] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack();
      const w = await weth.getAddress();
      expect(await factory.minEthUsd8()).to.equal(ETH_USD_MIN_8);
      expect(await factory.maxEthUsd8()).to.equal(ETH_USD_MAX_8);
      for (const px of [ETH_USD_MIN_8 - 1n, ETH_USD_MAX_8 + 1n, 10n ** 20n, 0n]) {
        await expect(
          launch(factory, tokenDeployer, creator, w, { ethUsdPrice8: px }, 0n, true),
        ).to.be.revertedWithCustomError(factory, "InvalidParams");
      }
    });

    it("accepts a price at either edge of the band", async () => {
      const [, creator] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack();
      const w = await weth.getAddress();
      await launch(factory, tokenDeployer, creator, w, { ethUsdPrice8: ETH_USD_MIN_8 });
      // distinct symbol: same creator + same args would collide on the CREATE2 address
      await launch(factory, tokenDeployer, creator, w, { ethUsdPrice8: ETH_USD_MAX_8, symbol: "VNT2" });
      expect(await factory.totalTokens()).to.equal(2n);
    });

    it("cannot be deployed with an empty or inverted band", async () => {
      await expect(deployStack(1n, [0n, ETH_USD_MAX_8])).to.be.reverted;
      await expect(deployStack(1n, [ETH_USD_MAX_8, ETH_USD_MIN_8])).to.be.reverted;
    });
  });

  describe("a raise cannot strand a few wei under target", () => {
    // The other half, a slice that lands within one token of target and must
    // count as filled, graduates inside the buy, so it needs a real
    // PoolManager: see "graduates inside the filling buy" in the fork suite.
    it("still refuses to finalize while the gap is genuinely reachable", async () => {
      const [, creator, buyer] = await ethers.getSigners();
      const target = ethers.parseEther("2");
      const { factory, tokenDeployer, weth } = await deployStack(1n);
      const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
        targetRaiseWei: target, maxBuyWei: target, symbol: "LIVE",
      });
      await (await factory.connect(buyer).buy(coin, { value: ethers.parseEther("0.5") })).wait();
      const st = await factory.curveState(coin);
      // Half a raise short is many tokens away, so the curve is still live.
      expect(st.targetRaiseWei - st.raisedWei).to.be.greaterThan(await factory.curveCost(coin, 1, st.soldWhole));
      await expect(factory.finalize(coin)).to.be.revertedWithCustomError(factory, "CurveLive");
    });
  });
});
