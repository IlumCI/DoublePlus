import { expect } from "chai";
import { ethers, network } from "hardhat";

import { DAY, deployStack, launch } from "./helpers/venture";

// The curve desk: a coin's fee and founder tax working from its first curve
// trade (pot, jackpot, dividends, buyback). Graduated-pool buybacks are
// covered by venture.fork.test.ts.

const OPEN = { mode: 1, founderRaiseBps: 0, maxBuyWei: 0 };

async function skip(secs: number) {
  await network.provider.send("evm_increaseTime", [secs]);
  await network.provider.send("evm_mine");
}

describe("Venture curve desk (unit)", function () {
  this.timeout(300_000);

  it("pays the pot to the last qualifying buyer once the timer runs out", async () => {
    const [, creator, a, b, c] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), OPEN);

    await (await factory.connect(a).buy(coin, 0, { value: ethers.parseEther("0.2") })).wait();
    await (await factory.connect(b).buy(coin, 0, { value: ethers.parseEther("0.1") })).wait();
    // A buy under potMinBuyWei (0.001 ETH) adds to the pot but doesn't lead.
    await (await factory.connect(c).buy(coin, 0, { value: ethers.parseEther("0.0005") })).wait();
    const pot = await desk.potOf(coin);
    expect(pot.leader).to.equal(b.address);
    await expect(desk.claimPot(coin)).to.be.revertedWithCustomError(desk, "PotNotWon");

    await skip(3601);
    const before = await weth.balanceOf(b.address);
    await (await desk.claimPot(coin)).wait();
    expect((await weth.balanceOf(b.address)) - before).to.equal(pot.eth);
    expect((await desk.potOf(coin)).leader).to.equal(ethers.ZeroAddress);
  });

  it("pays an expired pot inside the next trade, before that trade can lead", async () => {
    const [, creator, a, b] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), OPEN);
    await (await factory.connect(a).buy(coin, 0, { value: ethers.parseEther("0.2") })).wait();
    const won = (await desk.potOf(coin)).eth;
    await skip(3601);
    await (await factory.connect(b).buy(coin, 0, { value: ethers.parseEther("0.1") })).wait();
    expect(await weth.balanceOf(a.address)).to.equal(won);
    expect((await desk.potOf(coin)).leader).to.equal(b.address);
  });

  it("every Nth buy wins the jackpot, one count per signer per block", async () => {
    const [, creator, a, b, c] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk, hook } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), {
      ...OPEN, inLaunchWindow: true,
    });
    await (await hook.connect(creator).setModules(coin, {
      burnBps: 0, surgeBps: 0, jackpotBps: 2_000, jackpotEvery: 3, noFlip: false, set: false,
    })).wait();
    await skip(61);
    const v = ethers.parseEther("0.1");
    await (await factory.connect(a).buy(coin, 0, { value: v })).wait();
    await (await factory.connect(b).buy(coin, 0, { value: v })).wait();
    const jackpot = (await desk.jackpotOf(coin)).eth;
    expect(jackpot).to.be.greaterThan(0n);
    // The third buy's own tax joins the jackpot before it is paid.
    const [, tax] = await desk.charge(coin, c.address, v, true);
    const before = await weth.balanceOf(c.address);
    await (await factory.connect(c).buy(coin, 0, { value: v })).wait();
    expect((await weth.balanceOf(c.address)) - before).to.equal(jackpot + (tax * 2_000n) / 10_000n);
    const j = await desk.jackpotOf(coin);
    expect(j.eth).to.equal(0n);
    expect(j.buys).to.equal(3n);
  });

  it("fire() buys on an open curve and burns it, and never leads the pot", async () => {
    const [, creator, a, keeper] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), OPEN);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    for (let i = 0; i < 4; i++) await (await factory.connect(a).buy(coin, 0, { value: ethers.parseEther("0.25") })).wait();

    const loaded = await desk.buybackOf(coin);
    expect(loaded).to.be.greaterThan(0n);
    const supply = await erc.totalSupply();
    const price = await factory.priceNow(coin);
    const leader = (await desk.potOf(coin)).leader;

    await expect(desk.connect(keeper).fire(coin, ethers.MaxUint256)).to.be.revertedWithCustomError(factory, "SlippageExceeded");
    const rc = await (await desk.connect(keeper).fire(coin, 0)).wait();
    const ev = rc!.logs.map((l) => { try { return desk.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === "Buyback");
    const burned = ev!.args.burned as bigint;
    expect(burned).to.be.greaterThan(0n);
    expect(await erc.totalSupply()).to.equal(supply - burned);
    expect(await erc.balanceOf(await desk.getAddress())).to.equal(0n);
    expect(await factory.priceNow(coin)).to.be.greaterThan(price);
    expect((await desk.potOf(coin)).leader).to.equal(leader);
    // Its own buy paid tax, part of which reloads the buyback.
    expect(await desk.buybackOf(coin)).to.be.lessThan(loaded);
    await (await desk.fire(coin, 0)).wait();
    void weth;
  });

  it("a target raise's buyback waits for graduation; a failed raise's goes to the dev", async () => {
    const [, creator, a] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress());
    await (await factory.connect(a).buy(coin, 0, { value: ethers.parseEther("0.3") })).wait();
    const loaded = await desk.buybackOf(coin);
    await expect(desk.fire(coin, 0)).to.be.revertedWithCustomError(desk, "RaiseOpen");

    await skip(3 * DAY);
    await (await factory.abort(coin)).wait();
    const before = await weth.balanceOf(creator.address);
    await (await desk.fire(coin, 0)).wait();
    expect((await weth.balanceOf(creator.address)) - before).to.equal(loaded);
    await expect(desk.fire(coin, 0)).to.be.revertedWithCustomError(desk, "NothingToFire");
  });

  it("holders earn dividends from the first curve trade", async () => {
    const [, creator, a, b] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), OPEN);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    await (await factory.connect(a).buy(coin, 0, { value: ethers.parseEther("0.2") })).wait();
    // b's buy pays dividends to a (and to b, who already holds when it is credited).
    await (await factory.connect(b).buy(coin, 0, { value: ethers.parseEther("0.2") })).wait();
    const owedA = await erc.pendingRewards(a.address);
    expect(owedA).to.be.greaterThan(0n);
    const before = await weth.balanceOf(a.address);
    await (await erc.connect(a).claim()).wait();
    expect((await weth.balanceOf(a.address)) - before).to.equal(owedA);
  });

  it("only the factory can report a curve trade, and only the desk can credit curve dividends", async () => {
    const [, creator, x] = await ethers.getSigners();
    const { factory, tokenDeployer, weth, desk, hook } = await deployStack();
    const coin = await launch(factory, tokenDeployer, creator, await weth.getAddress(), OPEN);
    await expect(desk.connect(x).curveTrade(coin, x.address, true, 0, 0, { value: 1n })).to.be.revertedWithCustomError(desk, "NotFactory");
    await expect(hook.connect(x).curveDividends(coin, 1n)).to.be.revertedWithCustomError(hook, "NotLauncher");
    await expect(desk.connect(x).init(x.address, x.address, x.address)).to.be.revertedWithCustomError(desk, "AlreadyInit");
  });
});
