import { expect } from "chai";
import { ethers } from "hardhat";

// Does the suite actually have teeth?
//
// Every other test here is only worth as much as the machinery under it. If
// `expect` were stubbed to a no-op, if rejected promises were swallowed, or if
// a contract under test were replaced by something that returns constants,
// the whole suite would go green and say nothing. These checks fail in exactly
// those cases.
//
// A literally always-failing test is also available, behind EXPECT_FAIL=1:
//
//   EXPECT_FAIL=1 npx hardhat test test/harness.test.ts
//
// It is gated because a permanently red suite trains everyone to ignore red.
// Run it whenever you want proof that the runner still reports failures — in
// CI, or after touching the test config.

describe("test harness", function () {
  this.timeout(120_000);

  describe("assertions have teeth", () => {
    it("throws on a false assertion", () => {
      let threw = false;
      try {
        expect(1).to.equal(2);
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("expect() did not throw on a false assertion: assertions are stubbed");
    });

    it("throws when a deep-equality claim is wrong", () => {
      let threw = false;
      try {
        expect({ a: 1n }).to.deep.equal({ a: 2n });
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("deep equality did not throw: assertions are stubbed");
    });

    it("surfaces a rejected promise rather than swallowing it", async () => {
      let threw = false;
      try {
        await Promise.reject(new Error("boom"));
      } catch {
        threw = true;
      }
      if (!threw) throw new Error("an awaited rejection did not propagate");

      // The reverted-with matcher must fail when the call plainly succeeds,
      // otherwise every revert assertion in the suite is decorative.
      let matcherFailed = false;
      try {
        await expect(Promise.resolve(1)).to.be.revertedWith("nope");
      } catch {
        matcherFailed = true;
      }
      if (!matcherFailed) throw new Error("revertedWith passed on a resolving call: matchers are stubbed");
    });

    it("fails deliberately, on demand", function () {
      if (process.env.EXPECT_FAIL !== "1") {
        this.skip();
        return;
      }
      throw new Error("EXPECT_FAIL=1: this failure is intentional — the runner reports red correctly");
    });
  });

  describe("the contracts under test are real", () => {
    it("deploys bytecode of a plausible size, not an empty shell", async () => {
      const [admin] = await ethers.getSigners();
      const weth = await (await ethers.getContractFactory("WETH9")).deploy();
      await weth.waitForDeployment();
      const token = await (await ethers.getContractFactory("QuiverToken")).deploy(
        "Probe", "PRB", "", 10n ** 27n, admin.address, admin.address, 200, ethers.ZeroAddress, 0n, 0,
      );
      await token.waitForDeployment();

      for (const [name, addr] of [
        ["QuiverToken", await token.getAddress()],
        ["WETH9", await weth.getAddress()],
      ] as const) {
        const code = await ethers.provider.getCode(addr);
        expect(code, `${name} has no code`).to.not.equal("0x");
        expect((code.length - 2) / 2, `${name} looks like a stub`).to.be.greaterThan(1_000);
      }
    });

    it("computes dividend weight from state rather than returning a constant", async () => {
      const [admin, a, b] = await ethers.getSigners();
      const ONE = 10n ** 18n;
      const token = await (await ethers.getContractFactory("QuiverToken")).deploy(
        "Probe", "PRB", "", 1_000_000n * ONE, admin.address, admin.address, 200, ethers.ZeroAddress, 0n, 0,
      );
      await token.waitForDeployment();

      expect(await token.dividendWeight(a.address)).to.equal(0n);
      await (await token.transfer(a.address, 1_000n * ONE)).wait();
      await (await token.transfer(b.address, 2_000n * ONE)).wait();

      const wa = await token.dividendWeight(a.address);
      const wb = await token.dividendWeight(b.address);
      expect(wa).to.equal(1_000n * ONE);
      expect(wb).to.equal(2_000n * ONE);
      expect(wb).to.be.greaterThan(wa); // a constant-returning stub fails here
    });

    it("still reverts when it should: guards are wired, not decorative", async () => {
      const [admin, stranger] = await ethers.getSigners();
      const token = await (await ethers.getContractFactory("QuiverToken")).deploy(
        "Probe", "PRB", "", 10n ** 27n, admin.address, admin.address, 200, ethers.ZeroAddress, 0n, 0,
      );
      await token.waitForDeployment();

      // initHook is factory-only; the deployer above is the factory here.
      await expect(
        token.connect(stranger).initHook(stranger.address, []),
      ).to.be.revertedWithCustomError(token, "OnlyFactory");

      // And the constructor's own bounds hold.
      await expect(
        (await ethers.getContractFactory("QuiverToken")).deploy(
          "Bad", "BAD", "", 10n ** 27n, admin.address, admin.address, 1_001, ethers.ZeroAddress, 0n, 0,
        ),
      ).to.be.revertedWith("tax>10%");
    });
  });
});
