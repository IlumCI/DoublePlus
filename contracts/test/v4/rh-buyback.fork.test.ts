import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const NVDA_USD_8 = 200n * 10n ** 8n;
const buyPathNvda = ethers.solidityPacked(["address", "uint24", "address", "uint24", "address"], [WETH, 100, USDG, 3000, NVDA]);

async function deployAll(admin: any, feeRecipient: string) {
  const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhBuybackHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address", "address"],
    [POOL_MANAGER, admin.address, admin.address, feeRecipient, V3_ROUTER],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "", salt = "";
  for (let i = 0n; i < 500_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  const hook = await ethers.getContractAt("RhBuybackHook", hookAddr);

  const factory = await (await ethers.getContractFactory("RhBuybackFactory")).deploy(admin.address, admin.address, POOL_MANAGER, hookAddr);
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
  await router.waitForDeployment();
  return { hook, factory, router };
}

async function launch(factory: any, signer: any, name: string, symbol: string, pair: string, pairUsd8: bigint) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const fAddr = await factory.getAddress();
  const params = { name, symbol, metadataURI: "", pair, taxBps: 300, pairUsdPrice8: pairUsd8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [name, symbol, "", 10n ** 27n, signer.address, fAddr, 300, pair],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 3_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(fAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity");
  await (await factory.connect(signer).launch(params, salt)).wait();
  const total = await factory.totalTokens();
  return factory.allTokens(total - 1n);
}

describe("RhBuyback 50/40/10 + buyback-burn (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("splits fees 50/10/40 and burns the official token via buyback", async () => {
    const [admin, creator, platform, trader] = await ethers.getSigners();
    const { hook, factory, router } = await deployAll(admin, platform.address);

    // First launch = official token (paired vs NVDA). Set it as the buyback target.
    const official = await launch(factory, admin, "Official", "OFFICIAL", NVDA, NVDA_USD_8);
    await (await hook.setMainToken(official)).wait();
    const officialErc = await ethers.getContractAt("QuiverToken", official);
    const supplyBefore = await officialErc.totalSupply();

    // Second coin by a different creator, also NVDA-paired.
    const coin = await launch(factory, creator, "Meme", "MEME", NVDA, NVDA_USD_8);
    const nvda = await ethers.getContractAt("QuiverToken", NVDA);

    // Trader buys the coin with ETH (accrues coin-side fees), then sells part.
    await (await router.connect(trader).buy(coin, buyPathNvda, 0, { value: ethers.parseEther("0.03") })).wait();
    const coinErc = await ethers.getContractAt("QuiverToken", coin);
    const held = await coinErc.balanceOf(trader.address);
    await (await coinErc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, ethers.solidityPacked(["address","uint24","address","uint24","address"],[NVDA,3000,USDG,100,WETH]), 0)).wait();

    // Harvest: creator 50% NVDA, platform 10% NVDA, 40% -> NVDA buyback pot.
    const creatorBefore = await nvda.balanceOf(creator.address);
    const platformBefore = await nvda.balanceOf(platform.address);
    await (await hook.harvest(coin)).wait();
    expect(await nvda.balanceOf(creator.address) - creatorBefore, "creator got 50% in NVDA").to.be.greaterThan(0n);
    expect(await nvda.balanceOf(platform.address) - platformBefore, "platform got 10% in NVDA").to.be.greaterThan(0n);
    const pot = await hook.pairBuyback(NVDA);
    expect(pot, "40% accrued to buyback pot").to.be.greaterThan(0n);

    // Buyback + burn: NVDA pot buys the official token and burns it (pair == mainPair, empty V3 path).
    await (await hook.buybackBurn(NVDA, "0x", 0)).wait();
    expect(await hook.pairBuyback(NVDA), "pot spent").to.equal(0n);
    expect(await officialErc.totalSupply(), "official supply burned down").to.be.lessThan(supplyBefore);
  });

  it("keeps the hardcoded admin after ownership is renounced", async () => {
    const [admin, , platform, outsider] = await ethers.getSigners();
    const { hook, factory } = await deployAll(admin, platform.address);

    // Renounce Ownable on both; owner() reads as 0x0.
    await (await hook.renounceOwnership()).wait();
    await (await factory.renounceOwnership()).wait();
    expect(await hook.owner()).to.equal(ethers.ZeroAddress);
    expect(await factory.owner()).to.equal(ethers.ZeroAddress);

    // The immutable admin still administers both, post-renounce.
    await (await hook.connect(admin).setFeeRecipient(outsider.address)).wait();
    expect(await hook.feeRecipient()).to.equal(outsider.address);
    await (await factory.connect(admin).pause()).wait();
    expect(await factory.launchesPaused()).to.equal(true);

    // A non-admin cannot.
    await expect(hook.connect(outsider).setFeeRecipient(outsider.address)).to.be.revertedWith("not admin");
    await expect(factory.connect(outsider).pause()).to.be.revertedWithCustomError(factory, "NotProtocolAdmin");
  });
});
