import { expect } from "chai";
import { ethers, network } from "hardhat";

import { DAY, deployStack, launch, TARGET } from "./helpers/venture";

// Hostile-wallet suite. Every function that sends ETH is attacked with a
// recipient that re-enters, reverts, burns its gas or return-bombs, and every
// entry point is fed values at and past its edges. The rule each test checks:
// misbehaviour can only ever fail the attacker's own transaction. Other users,
// the escrow and the fee ledger must come out exactly as if it never happened.

enum Mode { Accept, Reenter, Revert, Burn, Bomb }

const SEED = 0xd1b54a32d192ed03n;
function rng(seed = SEED) {
  let s = seed;
  return () => {
    s ^= s << 13n; s &= (1n << 64n) - 1n;
    s ^= s >> 7n;
    s ^= s << 17n; s &= (1n << 64n) - 1n;
    return s;
  };
}

async function attacker() {
  const a = await (await ethers.getContractFactory("VentureAttacker")).deploy();
  await a.waitForDeployment();
  return a;
}

/** The custom error a reentry hit, decoded from the attacker's record. */
async function reentryError(factory: any, a: any): Promise<string> {
  const data = await a.lastReentryError();
  if (data === "0x") return "";
  try { return factory.interface.parseError(data)?.name ?? data; } catch { return data; }
}

describe("Venture launchpad (adversarial)", function () {
  this.timeout(900_000);

  it("blocks re-entry from a buy's change refund, and books the buy once", async () => {
    const [, creator] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: ethers.parseEther("10") });
    const a = await attacker();
    const fAddr = await factory.getAddress();
    await (await a.arm(Mode.Reenter, fAddr, factory.interface.encodeFunctionData("withdrawFees"))).wait();
    // An odd amount leaves change: the curve books whole tokens only.
    const value = ethers.parseEther("0.123456789123456789");
    await (await a.exec(fAddr, factory.interface.encodeFunctionData("buy", [coin, 0]), { value })).wait();
    expect(await a.reentries()).to.equal(1n);
    expect(await a.reentrySuccesses()).to.equal(0n);
    expect(await reentryError(factory, a)).to.equal("ReentrancyGuardReentrantCall");
    const st = await factory.curveState(coin);
    expect(await factory.spentWei(coin, await a.getAddress())).to.equal(st.raisedWei);
  });

  it("blocks re-entry from a sell payout and from a refund", async () => {
    const [, creator] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: ethers.parseEther("10") });
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const a = await attacker();
    const aAddr = await a.getAddress();
    const fAddr = await factory.getAddress();
    const sellData = (q: bigint) => factory.interface.encodeFunctionData("sell", [coin, q, 0]);

    await (await a.exec(fAddr, factory.interface.encodeFunctionData("buy", [coin, 0]), { value: ethers.parseEther("0.4") })).wait();
    await (await a.exec(coin, erc.interface.encodeFunctionData("approve", [fAddr, ethers.MaxUint256]))).wait();
    const owned = (await factory.boughtTokens(coin, aAddr)) / 10n ** 18n;

    // Sell a quarter; the payout tries to sell again.
    await (await a.arm(Mode.Reenter, fAddr, sellData(owned / 4n))).wait();
    await (await a.exec(fAddr, sellData(owned / 4n))).wait();
    expect(await a.reentrySuccesses()).to.equal(0n);
    expect(await reentryError(factory, a)).to.equal("ReentrancyGuardReentrantCall");
    expect((await factory.boughtTokens(coin, aAddr)) / 10n ** 18n).to.equal(owned - owned / 4n);

    // Kill the raise, then refund; the refund tries to refund again.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coin)).wait();
    const due = await factory.spentWei(coin, aAddr);
    const refundData = factory.interface.encodeFunctionData("refund", [coin]);
    await (await a.arm(Mode.Reenter, fAddr, refundData)).wait();
    const before = await ethers.provider.getBalance(aAddr);
    await (await a.exec(fAddr, refundData)).wait();
    expect((await ethers.provider.getBalance(aAddr)) - before).to.equal(due);
    expect(await a.reentrySuccesses()).to.equal(0n);
    expect(await factory.spentWei(coin, aAddr)).to.equal(0n);
    await expect(a.exec(fAddr, refundData)).to.be.revertedWithCustomError(factory, "NothingToRefund");
  });

  it("blocks re-entry from withdrawFees, and pays a referrer exactly once", async () => {
    const [, creator, buyer] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, hook } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: ethers.parseEther("10") });
    const a = await attacker();
    const aAddr = await a.getAddress();
    const fAddr = await factory.getAddress();
    await (await hook.connect(buyer).setReferrer(aAddr)).wait();
    await (await factory.connect(buyer).buy(coin, 0, { value: ethers.parseEther("1") })).wait();
    const owed = await factory.feesAccrued(aAddr);
    expect(owed).to.be.greaterThan(0n);

    const w = factory.interface.encodeFunctionData("withdrawFees");
    await (await a.arm(Mode.Reenter, fAddr, w)).wait();
    const before = await ethers.provider.getBalance(aAddr);
    await (await a.exec(fAddr, w)).wait();
    expect((await ethers.provider.getBalance(aAddr)) - before).to.equal(owed);
    expect(await a.reentrySuccesses()).to.equal(0n);
    expect(await factory.feesAccrued(aAddr)).to.equal(0n);
  });

  for (const [label, mode] of [["reverts", Mode.Revert], ["burns all gas", Mode.Burn], ["return-bombs", Mode.Bomb]] as const) {
    it(`a wallet that ${label} on receipt only fails its own transactions`, async () => {
      const [, creator, honest] = await ethers.getSigners();
      const { factory, tokenDeployer, weth } = await deployStack();
      const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: ethers.parseEther("10") });
      const a = await attacker();
      const fAddr = await factory.getAddress();
      await (await a.arm(mode, ethers.ZeroAddress, "0x")).wait();
      const before = await factory.curveState(coin);
      // Its buy has change to receive, so it cannot complete...
      await expect(a.exec(fAddr, factory.interface.encodeFunctionData("buy", [coin, 0]), {
        value: ethers.parseEther("0.123456789123456789"), gasLimit: 3_000_000,
      })).to.be.reverted;
      const after = await factory.curveState(coin);
      expect(after.raisedWei).to.equal(before.raisedWei);
      expect(after.soldWhole).to.equal(before.soldWhole);
      // ...and nobody else notices.
      await (await factory.connect(honest).buy(coin, 0, { value: ethers.parseEther("0.3") })).wait();
      expect((await factory.curveState(coin)).raisedWei).to.be.greaterThan(before.raisedWei);
    });
  }

  it("a creator that cannot take ETH strands only its own fees; backers still refund", async () => {
    const [, , b1, b2] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const a = await attacker();
    const fAddr = await factory.getAddress();
    // Launch as the attacker, in Open mode so it accrues a share of curve fees.
    const params = {
      name: "Hostile", symbol: "HOST", metadataURI: "", pair: await weth.getAddress(),
      buyTaxBps: 300, sellTaxBps: 300, devWallet: ethers.ZeroAddress,
      devBps: 2500, dividendBps: 2500, liquidityBps: 2500, mmBps: 2500,
      ethUsdPrice8: 1865n * 10n ** 8n, targetRaiseWei: TARGET, raiseDurationSecs: 2 * DAY,
      maxBuyWei: 0, founderRaiseBps: 0, founderSupplyBps: 0, vestingSecs: 0,
      mode: 1, minHoldForDividends: 0, dividendMode: 0, v3Path: "0x",
    };
    await (await a.exec(fAddr, factory.interface.encodeFunctionData("launch", [params, ethers.ZeroHash]))).wait();
    const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
    await network.provider.send("evm_increaseTime", [61]);
    await network.provider.send("evm_mine");
    await (await a.arm(Mode.Revert, ethers.ZeroAddress, "0x")).wait();
    await (await factory.connect(b1).buy(coin, 0, { value: ethers.parseEther("0.3") })).wait();
    await (await factory.connect(b2).buy(coin, 0, { value: ethers.parseEther("0.2") })).wait();
    const owed = await factory.feesAccrued(await a.getAddress());
    expect(owed).to.be.greaterThan(0n);
    await expect(a.exec(fAddr, factory.interface.encodeFunctionData("withdrawFees"))).to.be.reverted;
    expect(await factory.feesAccrued(await a.getAddress())).to.equal(owed);
    // Backers trade on regardless.
    const erc = await ethers.getContractAt("QuiverToken", coin);
    await (await erc.connect(b1).approve(fAddr, ethers.MaxUint256)).wait();
    await (await factory.connect(b1).sell(coin, 1_000_000n, 0)).wait();
  });

  it("holds up at the edges of every input", async () => {
    const [admin, creator, whale, stranger] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), { maxBuyWei: TARGET / 2n, mode: 0 });
    const fAddr = await factory.getAddress();
    const nobody = ethers.Wallet.createRandom().address;

    // Unknown tokens, empty buys, dust.
    await expect(factory.buy(nobody, 0, { value: 1n })).to.be.revertedWithCustomError(factory, "InvalidParams");
    await expect(factory.finalize(nobody)).to.be.revertedWithCustomError(factory, "InvalidParams");
    await expect(factory.abort(nobody)).to.be.revertedWithCustomError(factory, "InvalidParams");
    await expect(factory.buy(coin, 0)).to.be.revertedWithCustomError(factory, "InvalidParams");
    await expect(factory.buy(coin, 0, { value: 1n })).to.be.revertedWithCustomError(factory, "InvalidParams");
    await expect(factory.connect(stranger).withdrawFees()).to.be.revertedWithCustomError(factory, "NothingToRefund");
    await expect(factory.connect(stranger).sell(coin, 1n, 0)).to.be.revertedWithCustomError(factory, "NothingToSell");
    await expect(factory.refund(coin)).to.be.revertedWithCustomError(factory, "NotAborted");
    await expect(factory.abort(coin)).to.be.revertedWithCustomError(factory, "CurveLive");
    // An absurd floor reverts instead of filling at any price.
    await expect(factory.connect(whale).buy(coin, ethers.MaxUint256, { value: ethers.parseEther("0.1") }))
      .to.be.revertedWithCustomError(factory, "SlippageExceeded");

    // A whale with more ETH than exists hits the cap, not an overflow.
    await network.provider.send("hardhat_setBalance", [whale.address, "0x" + (10n ** 30n).toString(16)]);
    await expect(factory.connect(whale).buy(coin, 0, { value: 10n ** 29n })).to.be.revertedWithCustomError(factory, "CapExceeded");

    // Sell more than owned: capped to what the curve sold you.
    await (await factory.connect(stranger).buy(coin, 0, { value: ethers.parseEther("0.03") })).wait();
    const erc = await ethers.getContractAt("QuiverToken", coin);
    await (await erc.connect(stranger).approve(fAddr, ethers.MaxUint256)).wait();
    const owned = (await factory.boughtTokens(coin, stranger.address)) / 10n ** 18n;
    await (await factory.connect(stranger).sell(coin, owned * 1000n, 0)).wait();
    expect(await factory.boughtTokens(coin, stranger.address)).to.equal(0n);
    expect(await factory.spentWei(coin, stranger.address)).to.equal(0n);

    // Tokens moved to another wallet carry no curve position.
    await (await factory.connect(whale).buy(coin, 0, { value: ethers.parseEther("0.03") })).wait();
    const held = await erc.balanceOf(whale.address);
    await (await erc.connect(whale).transfer(admin.address, held)).wait();
    await (await erc.connect(admin).approve(fAddr, ethers.MaxUint256)).wait();
    await expect(factory.connect(admin).sell(coin, 1n, 0)).to.be.revertedWithCustomError(factory, "NothingToSell");
    // And the buyer who gave them away can no longer refund in full.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.abort(coin)).wait();
    await (await erc.connect(whale).approve(fAddr, ethers.MaxUint256)).wait();
    await expect(factory.connect(whale).refund(coin)).to.be.reverted;
    // The sweep waits the full delay, once.
    await expect(factory.sweepUnclaimed(coin)).to.be.revertedWithCustomError(factory, "SweepTooEarly");
    await network.provider.send("evm_increaseTime", [366 * DAY]);
    await network.provider.send("evm_mine");
    await (await factory.sweepUnclaimed(coin)).wait();
    await expect(factory.sweepUnclaimed(coin)).to.be.revertedWithCustomError(factory, "AlreadySwept");
    await expect(factory.connect(whale).refund(coin)).to.be.revertedWithCustomError(factory, "AlreadySwept");
  });

  it("launches only coherent curves under 150 random parameter sets", async () => {
    const [, creator] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack(ethers.parseEther("0.01"));
    const w = await weth.getAddress();
    const next = rng();
    const pick = (n: bigint) => next() % n;
    const C = 600_000_000n;
    let launched = 0, refused = 0;
    for (let i = 0; i < 150; i++) {
      // Each field is usually valid and sometimes just past an edge, so the
      // run covers both coherent launches and every kind of refusal.
      const edge = () => pick(5n) === 0n;
      const mode = Number(pick(2n));
      const o = {
        targetRaiseWei: edge()
          ? [0n, 1n, 10n ** 15n, 10n ** 24n + 1n, ethers.MaxUint256 / 2n][Number(pick(5n))]
          : [10n ** 16n, 10n ** 17n, 2n * 10n ** 18n, 10n ** 21n, 10n ** 24n][Number(pick(5n))] + pick(10n ** 15n),
        maxBuyWei: edge() ? [1n, 10n ** 12n][Number(pick(2n))] : [0n, 10n ** 18n, ethers.MaxUint256][Number(pick(3n))],
        founderRaiseBps: mode === 1 ? (edge() ? 1 : 0) : edge() ? 3_001 : Number(pick(3_001n)),
        founderSupplyBps: edge() ? 1_501 : Number(pick(1_501n)),
        vestingSecs: edge() ? 89 * 86_400 : 90 * 86_400 + Number(pick(640n * 86_400n)),
        raiseDurationSecs: edge() ? [0, 15 * 86_400][Number(pick(2n))] : 86_400 + Number(pick(13n * 86_400n)),
        buyTaxBps: edge() ? 401 : Number(pick(401n)),
        sellTaxBps: edge() ? 401 : Number(pick(401n)),
        mode,
        ethUsdPrice8: (edge() ? [1n, 999n, 10_001n][Number(pick(3n))] : 1_000n + pick(9_001n)) * 10n ** 8n,
        symbol: `F${i}`,
      };
      try {
        const coin = await launch(factory, tokenDeployer, creator, w, o);
        launched++;
        const st = await factory.curveState(coin);
        const t = await factory.terms(coin);
        // The whole curve costs the target, to rounding, and never more.
        const cost = await factory.curveCost(coin, C, 0);
        expect(cost, `iteration ${i}`).to.be.lessThanOrEqual(st.targetRaiseWei);
        expect(st.targetRaiseWei - cost, `iteration ${i}`).to.be.lessThan(10n ** 6n);
        // The price only rises, and the cap never makes the raise impossible.
        expect(await factory.curveCost(coin, 1, C - 1n), `iteration ${i}`).to.be.greaterThanOrEqual(t.basePriceWei);
        expect(t.maxBuyWei * 200n, `iteration ${i}`).to.be.greaterThanOrEqual(st.targetRaiseWei);
        // A minimal buy either fills or reverts cleanly, never corrupts state.
        await factory.buy(coin, 0, { value: st.targetRaiseWei / 1000n + 1n }).then((x: any) => x.wait()).catch(() => undefined);
        const after = await factory.curveState(coin);
        expect(after.raisedWei, `iteration ${i}`).to.be.lessThanOrEqual(st.targetRaiseWei);
      } catch (e: any) {
        if (String(e?.message).includes("iteration")) throw e;
        refused++;
      }
    }
    expect(launched, "some sets must be valid").to.be.greaterThan(10);
    expect(refused, "some sets must be refused").to.be.greaterThan(10);
  });

  it("stays solvent across three coins, hostile wallets, aborts, refunds and withdrawals", async () => {
    const signers = await ethers.getSigners();
    const [admin, creator, ...rest] = signers;
    const users = rest.slice(0, 6);
    const { factory, tokenDeployer, weth, hook } = await deployStack();
    const fAddr = await factory.getAddress();
    const w = await weth.getAddress();
    const coins = [
      await launch(factory, tokenDeployer, creator, w, { maxBuyWei: TARGET, symbol: "S1" }),
      await launch(factory, tokenDeployer, creator, w, { maxBuyWei: 0, mode: 1, founderRaiseBps: 0, symbol: "S2" }),
      await launch(factory, tokenDeployer, creator, w, { maxBuyWei: TARGET / 4n, symbol: "S3" }),
    ];
    const bad = await attacker();
    await (await bad.arm(Mode.Reenter, fAddr, factory.interface.encodeFunctionData("withdrawFees"))).wait();
    // Half the users are referred, one of them by the attacker.
    await (await hook.connect(users[0]).setReferrer(await bad.getAddress())).wait();
    await (await hook.connect(users[1]).setReferrer(users[2].address)).wait();
    for (const u of users) {
      for (const c of coins) {
        const erc = await ethers.getContractAt("QuiverToken", c);
        await (await erc.connect(u).approve(fAddr, ethers.MaxUint256)).wait();
      }
    }
    const feeHolders = [await hook.platformTreasury(), creator.address, await bad.getAddress(), ...users.map((u) => u.address)];

    const owed = async () => {
      let sum = 0n;
      for (const c of coins) {
        const st = await factory.curveState(c);
        const t = await factory.terms(c);
        if (!st.finalized && !t.swept) sum += st.raisedWei;
      }
      for (const h of feeHolders) sum += await factory.feesAccrued(h);
      return sum;
    };

    const next = rng(0x2545f4914f6cdd1dn);
    for (let step = 0; step < 220; step++) {
      const u = users[Number(next() % BigInt(users.length))];
      const c = coins[Number(next() % 3n)];
      const r = next() % 10n;
      try {
        if (r < 5n) {
          await (await factory.connect(u).buy(c, 0, { value: (next() % ethers.parseEther("0.2")) + 10n ** 14n })).wait();
        } else if (r < 8n) {
          const owned = (await factory.boughtTokens(c, u.address)) / 10n ** 18n;
          if (owned > 0n) await (await factory.connect(u).sell(c, (next() % owned) + 1n, 0)).wait();
        } else if (r === 8n) {
          await (await factory.connect(u).withdrawFees()).wait();
        } else {
          await (await bad.exec(fAddr, factory.interface.encodeFunctionData("buy", [c, 0]), { value: 10n ** 15n + (next() % 10n ** 15n) })).wait();
        }
      } catch { /* refused moves are fine; the ledger is what is checked */ }
      if (step % 20 === 0) {
        expect(await ethers.provider.getBalance(fAddr), `step ${step}`).to.be.greaterThanOrEqual(await owed());
      }
    }

    // Run the guaranteed raises out, abort them, refund everyone who can.
    await network.provider.send("evm_increaseTime", [3 * DAY]);
    await network.provider.send("evm_mine");
    for (const c of [coins[0], coins[2]]) {
      await factory.abort(c).then((x: any) => x.wait()).catch(() => undefined);
      for (const u of users) await factory.connect(u).refund(c).then((x: any) => x.wait()).catch(() => undefined);
    }
    for (const u of users) await factory.connect(u).withdrawFees().then((x: any) => x.wait()).catch(() => undefined);
    await factory.connect(admin).withdrawFees().then((x: any) => x.wait()).catch(() => undefined);
    expect(await ethers.provider.getBalance(fAddr)).to.be.greaterThanOrEqual(await owed());
    expect(await bad.reentrySuccesses()).to.equal(0n);
  });
});
