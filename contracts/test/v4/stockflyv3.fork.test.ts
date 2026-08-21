import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

// V3 model: fixed 2% trade tax, no platform cut, split 50% holders / 50%
// creator (feeRecipient). No burn, no auto-liquidity. This fork test proves
// the whole lifecycle: launch (with fee recipient + atomic dev buy), trade,
// fee routing, keeper conversion, poolSpot view, and protocolAdmin collect.
describe("StockFlyFactoryV3: fixed 2% tax, 50/50 creator/vault (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  async function deploySystem(admin: any, keeper: any) {
    const b20f = await (await ethers.getContractFactory("MockB20Factory")).deploy();
    await b20f.waitForDeployment();
    const vd = await (await ethers.getContractFactory("RewardVaultDeployer")).deploy();
    await vd.waitForDeployment();
    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });

    const Hook = await ethers.getContractFactory("StockFeeHookV3");
    const hookInit = ethers.concat([
      Hook.bytecode,
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["address", "address", "address", "address"],
        [POOL_MANAGER, admin.address, predictedFactory, admin.address],
      ),
    ]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 800_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    await (await c2.deploy(salt, hookInit)).wait();

    const factory = await (await ethers.getContractFactory("StockFlyFactoryV3")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH,
      await b20f.getAddress(), await vd.getAddress(), keeper.address, 4000n * 10n ** 8n,
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());

    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(
      POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
    );
    await router.waitForDeployment();
    const hook = await ethers.getContractAt("StockFeeHookV3", hookAddr);
    return { factory, router, hook, hookAddr };
  }

  it("routes the 2% tax 50/50 to a distinct feeRecipient and the vault", async () => {
    const [admin, creator, holder, keeper, feeWallet] = await ethers.getSigners();
    const { factory, router, hook, hookAddr } = await deploySystem(admin, keeper);

    // Launch with an explicit feeRecipient distinct from the creator, so we
    // prove the creator share lands where the form field points, not just at
    // msg.sender.
    const p = {
      name: "Alpha", symbol: "ALPHA", metadataURI: "ipfs://a",
      pair: WETH, feeRecipient: feeWallet.address, pairUsdPrice8: ETH_USD_8,
    };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);

    // Fixed tax recorded as 2%.
    const listing = await factory.listings(coin);
    expect(listing.taxBps, "fixed 2% tax").to.equal(200);
    expect(await factory.feeRecipientOf(coin), "fee recipient stored").to.equal(feeWallet.address);

    // Payees: exactly the feeRecipient @ 50% and the auto-minted vault @ 50%.
    const vault = await factory.rewardVaultOf(coin);
    expect(vault).to.not.equal(ethers.ZeroAddress);
    const coinIsC0 = coin.toLowerCase() < WETH.toLowerCase();
    const key = { currency0: coinIsC0 ? coin : WETH, currency1: coinIsC0 ? WETH : coin, fee: 0, tickSpacing: 60, hooks: hookAddr };
    const payees = await hook.payees(key as any);
    expect(payees.length).to.equal(2);
    const creatorPayee = payees.find((x: any) => x.to.toLowerCase() === feeWallet.address.toLowerCase());
    const vaultPayee = payees.find((x: any) => x.to.toLowerCase() === vault.toLowerCase());
    expect(creatorPayee, "feeRecipient is a payee").to.not.equal(undefined);
    expect(creatorPayee.shareBps, "creator half").to.equal(5000);
    expect(vaultPayee, "vault is a payee").to.not.equal(undefined);
    expect(vaultPayee.shareBps, "vault half").to.equal(5000);

    // Trade both directions; fee recipient and vault both accrue value.
    const feeWeth0 = await (await ethers.getContractAt("MockB20", WETH)).balanceOf(feeWallet.address);
    await (await router.connect(holder).buy(coin, "0x", 0, { value: ethers.parseEther("0.06") })).wait();
    await (await erc.connect(holder).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(holder).sell(coin, await erc.balanceOf(holder.address), "0x", 0)).wait();

    const weth = await ethers.getContractAt("MockB20", WETH);
    const feeAccrued = (await erc.balanceOf(feeWallet.address)) + (await weth.balanceOf(feeWallet.address)) - feeWeth0;
    const vaultFunded = (await erc.balanceOf(vault)) + (await weth.balanceOf(vault));
    expect(feeAccrued, "creator fee pushed to feeRecipient").to.be.greaterThan(0n);
    expect(vaultFunded, "vault funded by fees").to.be.greaterThan(0n);

    // Keeper can convert vault holdings into distributable rewards.
    const v = await ethers.getContractAt("StockRewardVault", vault);
    expect(await v.keeper()).to.equal(keeper.address);
    if ((await erc.balanceOf(vault)) > 0n) await (await v.connect(keeper).convert(0)).wait();
    expect(await v.distributable(), "reward ready").to.be.greaterThan(0n);
  });

  it("defaults feeRecipient to the launcher, does an atomic dev buy, and exposes poolSpot", async () => {
    const [admin, creator, , keeper] = await ethers.getSigners();
    const { factory } = await deploySystem(admin, keeper);

    const p = {
      name: "Beta", symbol: "BETA", metadataURI: "",
      pair: WETH, feeRecipient: ethers.ZeroAddress, pairUsdPrice8: ETH_USD_8,
    };
    // Atomic dev buy: send ETH with the launch; creator should receive coins
    // and nobody could have traded ahead of them.
    const tx = await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)), { value: ethers.parseEther("0.05") });
    await tx.wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);

    // Blank feeRecipient falls back to the launcher.
    expect(await factory.feeRecipientOf(coin)).to.equal(creator.address);
    // Dev buy delivered coins to the creator.
    expect(await erc.balanceOf(creator.address), "dev buy filled").to.be.greaterThan(0n);

    // poolSpot returns a live sqrt price, the coin's side, and pair decimals.
    const [sqrtPriceX96, tokenIsCurrency0, pairDecimals] = await factory.poolSpot(coin);
    expect(sqrtPriceX96, "live sqrt price").to.be.greaterThan(0n);
    expect(tokenIsCurrency0).to.equal(coin.toLowerCase() < WETH.toLowerCase());
    expect(pairDecimals, "WETH is 18 decimals").to.equal(18);
  });

  it("lets only protocolAdmin collect factory-held liquidity", async () => {
    const [admin, creator, , keeper, recipient, stranger] = await ethers.getSigners();
    const { factory } = await deploySystem(admin, keeper);

    const p = {
      name: "Gamma", symbol: "GAMMA", metadataURI: "",
      pair: WETH, feeRecipient: ethers.ZeroAddress, pairUsdPrice8: ETH_USD_8,
    };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);

    await expect(factory.connect(stranger).collect(coin, 5000, recipient.address)).to.be.reverted;

    const before = await erc.balanceOf(recipient.address);
    await (await factory.connect(admin).collect(coin, 5000, recipient.address)).wait();
    expect(await erc.balanceOf(recipient.address), "collect returned coin liquidity").to.be.greaterThan(before);
  });
});
