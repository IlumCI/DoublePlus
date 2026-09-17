import { expect } from "chai";
import { ethers } from "hardhat";

// Dividend weight is what every distribution divides by, so it is worth
// pinning directly: the token is deployed here on its own, with no factory,
// hook or pool in the way.

const ONE = 10n ** 18n;
const SUPPLY = 1_000_000_000n * ONE;

async function token(minHoldWhole: bigint, mode: number) {
  const [deployer] = await ethers.getSigners();
  const t = await (await ethers.getContractFactory("QuiverToken")).deploy(
    "Openkernel", "KERN", "", SUPPLY, deployer.address, deployer.address, 200,
    ethers.ZeroAddress, minHoldWhole * ONE, mode,
  );
  await t.waitForDeployment();
  return t;
}

describe("QuiverToken dividend weight", function () {
  this.timeout(120_000);

  it("is the plain balance when linear with no floor, and tracks the supply", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const t = await token(0n, 0);
    await (await t.transfer(alice.address, 5_000n * ONE)).wait();
    await (await t.transfer(bob.address, 1_000n * ONE)).wait();

    expect(await t.dividendWeight(alice.address)).to.equal(5_000n * ONE);
    expect(await t.dividendWeight(bob.address)).to.equal(1_000n * ONE);
    // The recipient of the mint is excluded, so only real holders count.
    expect(await t.eligibleSupply()).to.equal(6_000n * ONE);
  });

  it("pays nothing below the floor and everything above it", async () => {
    const [, alice, bob] = await ethers.getSigners();
    const t = await token(10_000n, 0);
    await (await t.transfer(alice.address, 9_999n * ONE)).wait(); // one short
    await (await t.transfer(bob.address, 10_000n * ONE)).wait();

    expect(await t.dividendWeight(alice.address)).to.equal(0n);
    expect(await t.dividendWeight(bob.address)).to.equal(10_000n * ONE);
    expect(await t.eligibleSupply()).to.equal(10_000n * ONE);

    // Crossing the floor upward adds the whole balance to the denominator,
    // not just the tokens that took it over the line.
    await (await t.transfer(alice.address, 1n * ONE)).wait();
    expect(await t.dividendWeight(alice.address)).to.equal(10_000n * ONE);
    expect(await t.eligibleSupply()).to.equal(20_000n * ONE);

    // And falling back under removes all of it.
    await (await t.connect(alice).transfer(bob.address, 1n * ONE)).wait();
    expect(await t.dividendWeight(alice.address)).to.equal(0n);
    expect(await t.eligibleSupply()).to.equal(10_001n * ONE);
  });

  it("steps the multiplier at 10x, 100x and 1000x the floor, capped at 2x", async () => {
    const [, a, b, c, d] = await ethers.getSigners();
    const t = await token(1_000n, 1);
    await (await t.transfer(a.address, 1_000n * ONE)).wait();     // 1x    -> 1.00
    await (await t.transfer(b.address, 10_000n * ONE)).wait();    // 10x   -> 1.25
    await (await t.transfer(c.address, 100_000n * ONE)).wait();   // 100x  -> 1.50
    await (await t.transfer(d.address, 1_000_000n * ONE)).wait(); // 1000x -> 2.00

    expect(await t.dividendWeight(a.address)).to.equal(1_000n * ONE);
    expect(await t.dividendWeight(b.address)).to.equal((10_000n * ONE * 12_500n) / 10_000n);
    expect(await t.dividendWeight(c.address)).to.equal((100_000n * ONE * 15_000n) / 10_000n);
    expect(await t.dividendWeight(d.address)).to.equal(2_000_000n * ONE);
  });

  it("cannot be farmed by splitting a balance across wallets", async () => {
    const [, whale, s1, s2] = await ethers.getSigners();
    const t = await token(1_000n, 1);
    await (await t.transfer(whale.address, 1_000_000n * ONE)).wait();
    const whole = await t.dividendWeight(whale.address); // 2.00x

    // Split it in two: each half now sits a tier lower, so the pair is worth
    // strictly less than the single holding was.
    await (await t.connect(whale).transfer(s1.address, 500_000n * ONE)).wait();
    const split = (await t.dividendWeight(whale.address)) + (await t.dividendWeight(s1.address));
    expect(split).to.be.lessThan(whole);

    // Splitting again inside one tier is merely neutral — the guarantee is
    // that splitting never pays, not that every split costs.
    await (await t.connect(s1).transfer(s2.address, 250_000n * ONE)).wait();
    const thrice =
      (await t.dividendWeight(whale.address)) +
      (await t.dividendWeight(s1.address)) +
      (await t.dividendWeight(s2.address));
    expect(thrice).to.be.at.most(split);

    // Crossing a boundary costs again: 250k sits at 250x, and halving it to
    // 125k each leaves both still at 100x, but dropping under 100x does bite.
    await (await t.connect(s2).transfer(whale.address, 250_000n * ONE - 99_000n * ONE)).wait();
    const after =
      (await t.dividendWeight(whale.address)) +
      (await t.dividendWeight(s1.address)) +
      (await t.dividendWeight(s2.address));
    expect(await t.dividendWeight(s2.address)).to.equal((99_000n * ONE * 12_500n) / 10_000n);
    expect(after).to.be.at.most(whole);
  });

  it("keeps eligibleSupply equal to the sum of every holder's weight", async () => {
    const signers = (await ethers.getSigners()).slice(1, 7);
    const t = await token(1_000n, 1);
    const amounts = [400n, 1_000n, 9_999n, 12_000n, 150_000n, 2_000_000n];
    for (let i = 0; i < signers.length; i++) {
      await (await t.transfer(signers[i].address, amounts[i] * ONE)).wait();
    }
    let sum = 0n;
    for (const s of signers) sum += await t.dividendWeight(s.address);
    expect(await t.eligibleSupply()).to.equal(sum);

    // Move tokens around and the invariant has to survive every crossing.
    await (await t.connect(signers[5]).transfer(signers[0].address, 1_999_000n * ONE)).wait();
    await (await t.connect(signers[2]).transfer(signers[1].address, 9_999n * ONE)).wait();
    sum = 0n;
    for (const s of signers) sum += await t.dividendWeight(s.address);
    expect(await t.eligibleSupply()).to.equal(sum);
  });
});
