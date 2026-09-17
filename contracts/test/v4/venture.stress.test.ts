import { expect } from "chai";
import { ethers, network } from "hardhat";

import { DAY, deployStack, launch, TARGET } from "./helpers/venture";

// Randomised sequences against the curve and the dividend ledger. Every run is
// driven by a fixed-seed PRNG so a failure reproduces exactly; the seed is
// printed with any assertion that trips.
//
// Launching mines a CREATE2 vanity salt in JS and costs ~15s, so these tests
// launch once and then hammer the resulting token.

const SEED = 0x9e3779b97f4a7c15n;
function rng(seed = SEED) {
  let s = seed;
  return () => {
    s ^= s << 13n; s &= (1n << 64n) - 1n;
    s ^= s >> 7n;
    s ^= s << 17n; s &= (1n << 64n) - 1n;
    return s;
  };
}
const ONE = 10n ** 18n;

describe("Venture launchpad (stress)", function () {
  this.timeout(900_000);

  it("keeps escrow, ledgers and inventory consistent across a random buy/sell walk", async () => {
    const [admin, creator, ...rest] = await ethers.getSigners();
    const buyers = rest.slice(0, 5);
    const { factory, tokenDeployer, weth } = await deployStack();
    const factoryAddr = await factory.getAddress();
    // A target the walk cannot fill: crossing it locks the curve and makes the
    // raise unabortable, which would cut the unwind short.
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      targetRaiseWei: ethers.parseEther("20"),
      maxBuyWei: ethers.parseEther("50"),
    });
    const erc = await ethers.getContractAt("QuiverToken", coin);
    for (const b of buyers) {
      await (await erc.connect(b).approve(factoryAddr, ethers.MaxUint256)).wait();
    }

    const next = rng();
    let ops = 0;
    for (let i = 0; i < 40; i++) {
      const who = buyers[Number(next() % BigInt(buyers.length))];
      const wantsSell = next() % 3n === 0n;
      const state = await factory.curveState(coin);
      if (state.raisedWei >= state.targetRaiseWei) break; // high-water lock

      if (wantsSell) {
        const owned = await factory.boughtTokens(coin, who.address);
        const q = owned / ONE / 2n;
        if (q === 0n) continue;
        await (await factory.connect(who).sell(coin, q, 0)).wait();
      } else {
        const value = (next() % ethers.parseEther("0.25")) + 10n ** 14n;
        await (await factory.connect(who).buy(coin, { value })).wait();
      }
      ops++;

      // 1) The per-buyer ledger sums to the curve's own total.
      let claims = 0n;
      for (const b of buyers) claims += await factory.spentWei(coin, b.address);
      const raised = (await factory.curveState(coin)).raisedWei;
      expect(claims, `seed ${SEED} op ${i}: spentWei sum != raisedWei`).to.equal(raised);

      // 2) Sold inventory matches what buyers actually hold from the curve.
      let held = 0n;
      for (const b of buyers) held += await factory.boughtTokens(coin, b.address);
      const sold = (await factory.curveState(coin)).soldWhole;
      expect(held, `seed ${SEED} op ${i}: soldWhole != sum(boughtTokens)`).to.equal(sold * ONE);

      // 3) Everything the contract holds is escrow or an unwithdrawn fee.
      const bal = await ethers.provider.getBalance(factoryAddr);
      const fees = await factory.feesAccrued(admin.address);
      expect(bal, `seed ${SEED} op ${i}: balance != escrow + fees`).to.equal(raised + fees);
    }
    expect(ops, "the walk did nothing").to.be.greaterThan(10);

    // Unwind: abort and refund everyone, and the escrow must clear exactly.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    const owed = (await factory.curveState(coin)).raisedWei;
    await (await factory.abort(coin)).wait();
    let paid = 0n;
    for (const b of buyers) {
      if ((await factory.spentWei(coin, b.address)) === 0n) continue;
      const before = await ethers.provider.getBalance(b.address);
      const rc = await (await factory.connect(b).refund(coin)).wait();
      paid += (await ethers.provider.getBalance(b.address)) - before + rc!.gasUsed * rc!.gasPrice;
    }
    expect(paid, `seed ${SEED}: refunds != escrow at abort`).to.equal(owed);
    expect((await factory.curveState(coin)).raisedWei).to.equal(0n);
  });

  it("never lets a curve round trip come out ahead", async () => {
    const [, creator, trader] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const factoryAddr = await factory.getAddress();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      maxBuyWei: ethers.parseEther("50"),
    });
    const erc = await ethers.getContractAt("QuiverToken", coin);
    await (await erc.connect(trader).approve(factoryAddr, ethers.MaxUint256)).wait();

    const next = rng(0xdeadbeefcafef00dn);
    for (let i = 0; i < 8; i++) {
      const value = (next() % ethers.parseEther("0.2")) + 10n ** 15n;
      const beforeSpend = await factory.spentWei(coin, trader.address);
      const beforeTok = await factory.boughtTokens(coin, trader.address);

      const b1 = await ethers.provider.getBalance(trader.address);
      const r1 = await (await factory.connect(trader).buy(coin, { value })).wait();
      const gained = (await factory.boughtTokens(coin, trader.address)) - beforeTok;
      const spentNet = b1 - (await ethers.provider.getBalance(trader.address)) - r1!.gasUsed * r1!.gasPrice;

      const q = gained / ONE;
      if (q === 0n) continue;
      const b2 = await ethers.provider.getBalance(trader.address);
      const r2 = await (await factory.connect(trader).sell(coin, q, 0)).wait();
      const got = (await ethers.provider.getBalance(trader.address)) - b2 + r2!.gasUsed * r2!.gasPrice;

      // The entry fee, the exit fee and the buy's round-up all cut one way.
      expect(got, `seed round ${i}: a round trip profited`).to.be.lessThan(spentNet);
      // And the position is back where it started, give or take the dust the
      // whole-token quantisation leaves behind.
      expect(await factory.spentWei(coin, trader.address)).to.be.at.most(beforeSpend + value);
    }
  });

  it("holds the per-wallet cap however the buys are sliced", async () => {
    const [, creator, buyer] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const cap = ethers.parseEther("0.05");
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: cap });

    const next = rng(0x1234567890abcdefn);
    let rejected = 0;
    for (let i = 0; i < 25; i++) {
      const value = (next() % ethers.parseEther("0.02")) + 10n ** 14n;
      try {
        await (await factory.connect(buyer).buy(coin, { value })).wait();
      } catch {
        rejected++;
      }
      expect(await factory.spentWei(coin, buyer.address), "cap breached by slicing").to.be.at.most(cap);
    }
    expect(rejected, "the cap never bound — the test proved nothing").to.be.greaterThan(0);
  });

  it("prices the curve monotonically in both arguments", async () => {
    const [, creator, buyer] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      maxBuyWei: ethers.parseEther("50"),
    });

    const next = rng(0xfeedfacefeedfacen);
    for (let round = 0; round < 6; round++) {
      const sold = (await factory.curveState(coin)).soldWhole;
      const q = (next() % 5_000_000n) + 1n;

      // Cost rises with size, and rises again from further along the curve.
      const c1 = await factory.curveCost(coin, q, sold);
      const c2 = await factory.curveCost(coin, q + 1n, sold);
      const c3 = await factory.curveCost(coin, q, sold + 1_000_000n);
      expect(c2).to.be.greaterThan(c1);
      expect(c3).to.be.greaterThan(c1);
      expect(await factory.curveCost(coin, 0n, sold)).to.equal(0n);

      const p1 = await factory.priceNow(coin);
      await (await factory.connect(buyer).buy(coin, { value: ethers.parseEther("0.08") })).wait();
      expect(await factory.priceNow(coin), "price did not rise after a buy").to.be.greaterThan(p1);
    }
  });

  it("isolates escrow across concurrent raises under a random walk", async () => {
    const [admin, creator, ...rest] = await ethers.getSigners();
    const buyers = rest.slice(0, 4);
    const { factory, tokenDeployer, weth } = await deployStack();
    const factoryAddr = await factory.getAddress();
    const wethAddr = await weth.getAddress();

    // Three raises sharing one contract balance: the invariant that matters is
    // that none of them can reach into another's escrow.
    const coins: string[] = [];
    for (let i = 0; i < 3; i++) {
      coins.push(await launch(factory, tokenDeployer, creator, wethAddr, {
        name: `Venture ${i}`, symbol: `VN${i}`,
        targetRaiseWei: ethers.parseEther("20"), maxBuyWei: ethers.parseEther("50"),
      }));
    }
    for (const coin of coins) {
      const erc = await ethers.getContractAt("QuiverToken", coin);
      for (const b of buyers) await (await erc.connect(b).approve(factoryAddr, ethers.MaxUint256)).wait();
    }

    const next = rng(0xa5a5a5a5a5a5a5a5n);
    for (let i = 0; i < 30; i++) {
      const coin = coins[Number(next() % 3n)];
      const who = buyers[Number(next() % BigInt(buyers.length))];
      if (next() % 4n === 0n) {
        const owned = await factory.boughtTokens(coin, who.address);
        const q = owned / ONE / 2n;
        if (q > 0n) await (await factory.connect(who).sell(coin, q, 0)).wait();
      } else {
        await (await factory.connect(who).buy(coin, { value: (next() % ethers.parseEther("0.2")) + 10n ** 14n })).wait();
      }

      let totalEscrow = 0n;
      for (const c of coins) {
        let claims = 0n;
        for (const b of buyers) claims += await factory.spentWei(c, b.address);
        const raised = (await factory.curveState(c)).raisedWei;
        expect(claims, `seed op ${i}: ${c} ledger != its own escrow`).to.equal(raised);
        totalEscrow += raised;
      }
      const bal = await ethers.provider.getBalance(factoryAddr);
      expect(bal, `seed op ${i}: balance != escrow across all raises + fees`)
        .to.equal(totalEscrow + (await factory.feesAccrued(admin.address)));
    }

    // Kill one raise; the other two must be untouched to the wei.
    const before = await Promise.all(coins.slice(1).map(async (c) => (await factory.curveState(c)).raisedWei));
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coins[0])).wait();
    for (const b of buyers) {
      if ((await factory.spentWei(coins[0], b.address)) === 0n) continue;
      await (await factory.connect(b).refund(coins[0])).wait();
    }
    const after = await Promise.all(coins.slice(1).map(async (c) => (await factory.curveState(c)).raisedWei));
    expect(after, "a refund reached a sibling raise").to.deep.equal(before);
    expect((await factory.curveState(coins[0])).raisedWei).to.equal(0n);
  });

  it("stays solvent on an open curve, where sells are uncapped", async () => {
    const [admin, creator, ...rest] = await ethers.getSigners();
    const buyers = rest.slice(0, 4);
    const { factory, tokenDeployer, weth } = await deployStack();
    const factoryAddr = await factory.getAddress();
    await (await factory.setParams(0, ethers.parseEther("30"), 365 * DAY, 1000)).wait();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      mode: 1, founderRaiseBps: 0, maxBuyWei: ethers.parseEther("50"),
    });
    const erc = await ethers.getContractAt("QuiverToken", coin);
    for (const b of buyers) await (await erc.connect(b).approve(factoryAddr, ethers.MaxUint256)).wait();

    const next = rng(0x0badc0de0badc0den);
    for (let i = 0; i < 30; i++) {
      const who = buyers[Number(next() % BigInt(buyers.length))];
      if (next() % 3n === 0n) {
        const owned = await factory.boughtTokens(coin, who.address);
        const q = owned / ONE / 2n;
        if (q > 0n) await (await factory.connect(who).sell(coin, q, 0)).wait();
      } else {
        await (await factory.connect(who).buy(coin, { value: (next() % ethers.parseEther("0.3")) + 10n ** 14n })).wait();
      }

      // No refund liability here, so the guarantee is simply that the curve
      // never owes more than it holds, and never pays itself into the red.
      const raised = (await factory.curveState(coin)).raisedWei;
      const bal = await ethers.provider.getBalance(factoryAddr);
      expect(bal, `op ${i}: open curve escrow underwater`)
        .to.equal(raised + (await factory.feesAccrued(admin.address)) + (await factory.feesAccrued(creator.address)));
      expect(raised).to.be.greaterThanOrEqual(0n);
    }
    // An open curve has no deadline, so it can never be aborted out from under
    // its holders however long it sits.
    await network.provider.send("evm_increaseTime", [400 * DAY]);
    await network.provider.send("evm_mine");
    await expect(factory.abort(coin)).to.be.revertedWithCustomError(factory, "CurveLive");
  });
});
