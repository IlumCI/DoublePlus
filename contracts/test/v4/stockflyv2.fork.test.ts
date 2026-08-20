import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

describe("StockFlyFactoryV2: auto reward vault per launch (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("mints a holder-reward vault at launch and funds it from fees", async () => {
    const [admin, creator, holder, keeper] = await ethers.getSigners();

    const b20f = await (await ethers.getContractFactory("MockB20Factory")).deploy();
    await b20f.waitForDeployment();
    const vd = await (await ethers.getContractFactory("RewardVaultDeployer")).deploy();
    await vd.waitForDeployment();
    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });

    const Hook = await ethers.getContractFactory("StockFeeHook");
    const hookInit = ethers.concat([
      Hook.bytecode,
      ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "address", "address"], [POOL_MANAGER, admin.address, predictedFactory, admin.address]),
    ]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 800_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    await (await c2.deploy(salt, hookInit)).wait();
    const hook = await ethers.getContractAt("StockFeeHook", hookAddr);

    const factory = await (await ethers.getContractFactory("StockFlyFactoryV2")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, await b20f.getAddress(), await vd.getAddress(), keeper.address, 4000n * 10n ** 8n,
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());
    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
    await router.waitForDeployment();

    // Launch. No burn/liquidity, so the payee share is 100% -> 50% creator,
    // 50% the auto-minted reward vault.
    const p = { name: "Alpha", symbol: "ALPHA", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8, burnBps: 0, liquidityBps: 0 };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);

    // A vault was auto-minted and registered.
    const vault = await factory.rewardVaultOf(coin);
    expect(vault, "vault auto-minted").to.properAddress;
    expect(vault).to.not.equal(ethers.ZeroAddress);

    // It is a payee at 50%, the creator holds the other 50%.
    const coinIsC0 = coin.toLowerCase() < WETH.toLowerCase();
    const key = { currency0: coinIsC0 ? coin : WETH, currency1: coinIsC0 ? WETH : coin, fee: 0, tickSpacing: 60, hooks: hookAddr };
    const payees = await hook.payees(key as any);
    expect(payees.length, "creator + vault").to.equal(2);
    const vaultPayee = payees.find((x: any) => x.to.toLowerCase() === vault.toLowerCase());
    expect(vaultPayee, "vault is a payee").to.not.equal(undefined);
    expect(vaultPayee.shareBps, "vault gets half").to.equal(5000);

    // Trading funds the vault.
    await (await router.connect(holder).buy(coin, "0x", 0, { value: ethers.parseEther("0.06") })).wait();
    await (await erc.connect(holder).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(holder).sell(coin, await erc.balanceOf(holder.address), "0x", 0)).wait();

    const weth = await ethers.getContractAt("MockB20", WETH);
    const funded = (await erc.balanceOf(vault)) + (await weth.balanceOf(vault));
    expect(funded, "vault funded by fees").to.be.greaterThan(0n);

    // The vault's keeper is the one we set, and it can convert.
    const v = await ethers.getContractAt("StockRewardVault", vault);
    expect(await v.keeper()).to.equal(keeper.address);
    if ((await erc.balanceOf(vault)) > 0n) await (await v.connect(keeper).convert(0)).wait();
    expect(await v.distributable(), "reward ready to distribute").to.be.greaterThan(0n);
  });
});
