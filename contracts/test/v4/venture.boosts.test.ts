import { expect } from "chai";
import { ethers, network } from "hardhat";

import { deployStack, launch } from "./helpers/venture";

describe("VentureBoosts", () => {
  it("sells hours of placement, stacks a live run, resets a lapsed one, and pays the treasury", async () => {
    const [admin, founder, fan, treasury] = await ethers.getSigners();
    const { factory, tokenDeployer, weth } = await deployStack();
    await launch(factory, tokenDeployer, founder, await weth.getAddress());
    const coin = await factory.allTokens(0);
    const price = ethers.parseEther("0.001");
    const boosts = await (await ethers.getContractFactory("VentureBoosts")).deploy(await factory.getAddress(), treasury.address, price);

    await expect(boosts.connect(fan).boost(admin.address, 1, { value: price })).to.be.revertedWithCustomError(boosts, "NotListed");
    await expect(boosts.connect(fan).boost(coin, 0)).to.be.revertedWithCustomError(boosts, "BadHours");
    await expect(boosts.connect(fan).boost(coin, 169, { value: price * 169n })).to.be.revertedWithCustomError(boosts, "BadHours");
    await expect(boosts.connect(fan).boost(coin, 2, { value: price })).to.be.revertedWithCustomError(boosts, "WrongPayment");

    const t0 = await ethers.provider.getBalance(treasury.address);
    await (await boosts.connect(fan).boost(coin, 2, { value: price * 2n })).wait();
    const first = await boosts.activeBoost(coin);
    expect(first.paid).to.equal(price * 2n);
    // A second boost on a live run extends it and adds to what it paid.
    await (await boosts.connect(founder).boost(coin, 3, { value: price * 3n })).wait();
    const second = await boosts.activeBoost(coin);
    expect(second.until - first.until).to.equal(3n * 3600n);
    expect(second.paid).to.equal(price * 5n);
    expect((await ethers.provider.getBalance(treasury.address)) - t0).to.equal(price * 5n);

    // Once it lapses it reads as nothing, and the next run starts fresh.
    await network.provider.send("evm_increaseTime", [6 * 3600]);
    await network.provider.send("evm_mine");
    expect((await boosts.activeBoost(coin)).paid).to.equal(0n);
    await (await boosts.connect(fan).boost(coin, 1, { value: price })).wait();
    expect((await boosts.activeBoost(coin)).paid).to.equal(price);
  });
});
