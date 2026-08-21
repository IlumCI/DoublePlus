import { expect } from "chai";
import { ethers, network } from "hardhat";

// Base mainnet
const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
// beforeInitialize (1<<13) + afterSwap (1<<6) + afterSwapReturnDelta (1<<2)
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

describe("StockFeeHook launchpad on Base: configurable split + any pair (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("splits fees platform/burn/liquidity/payee and pairs any token", async () => {
    const [admin, creator, trader] = await ethers.getSigners();

    const b20f = await (await ethers.getContractFactory("MockB20Factory")).deploy();
    await b20f.waitForDeployment();

    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    // The factory is deployed right after the hook, so predict its address.
    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });

    // Mine a hook address carrying the right permission flags.
    const Hook = await ethers.getContractFactory("StockFeeHook");
    const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address", "address"],
      [POOL_MANAGER, admin.address, predictedFactory, admin.address],
    );
    const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 800_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    expect(hookAddr, "mined a flagged hook address").to.not.equal("");
    await (await c2.deploy(salt, hookInit)).wait();
    const hook = await ethers.getContractAt("StockFeeHook", hookAddr);

    const factory = await (await ethers.getContractFactory("StockFlyFactory")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, await b20f.getAddress(),
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());

    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(
      POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
    );
    await router.waitForDeployment();
    const weth = await ethers.getContractAt("MockB20", WETH);

    // Launch a coin against WETH: 1% tax, 20% burn, 20% liquidity, 60% payee.
    const p = {
      name: "Alpha", symbol: "ALPHA", metadataURI: "",
      pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8, burnBps: 2000, liquidityBps: 2000,
    };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)), { value: ethers.parseEther("0.003") })).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);
    expect(await erc.balanceOf(creator.address), "dev buy delivered").to.be.greaterThan(0n);

    // The pool config is on the hook, with the creator as sole payee at 60%.
    const key = { currency0: coin < WETH ? coin : WETH, currency1: coin < WETH ? WETH : coin, fee: 0, tickSpacing: 60, hooks: hookAddr };
    const payees = await hook.payees(key as any);
    expect(payees.length, "one payee").to.equal(1);
    expect(payees[0].to).to.equal(creator.address);
    expect(payees[0].shareBps, "creator payee 60%").to.equal(6000);

    // A trade routes fees: platform treasury and the creator payee both earn
    // the fee currency; some supply burns.
    const platBefore = await weth.balanceOf(admin.address);
    const creatorWethBefore = await weth.balanceOf(creator.address);
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.05") })).wait();
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, await erc.balanceOf(trader.address), "0x", 0)).wait();

    expect((await weth.balanceOf(admin.address)) - platBefore, "platform earned fees").to.be.greaterThan(0n);
    expect((await weth.balanceOf(creator.address)) - creatorWethBefore, "creator payee earned fees").to.be.greaterThan(0n);
    expect(await erc.balanceOf("0x000000000000000000000000000000000000dEaD"), "coin burned by fee split").to.be.greaterThan(0n);

    // All stocks pairable: launch a second coin paired against a mock B-20
    // "stock" token (proves the factory accepts any pair, not just WETH).
    const stock = await (await ethers.getContractFactory("MockB20")).deploy("Wrapped MSTR", "wtMSTR", admin.address, 18);
    await stock.waitForDeployment();
    const stockAddr = await stock.getAddress();
    const pStock = {
      name: "MoonStock", symbol: "MOON", metadataURI: "",
      pair: stockAddr, taxBps: 100, pairUsdPrice8: 350n * 10n ** 8n, burnBps: 1000, liquidityBps: 1000,
    };
    await (await factory.connect(creator).launch(pStock, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin2 = await factory.allTokens(1n);
    expect(coin2, "stock-paired coin launched").to.properAddress;
    expect((await factory.listings(coin2)).pair, "paired against the stock token").to.equal(stockAddr);
  });
});
