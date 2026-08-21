import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

const wethAbi = [
  "function deposit() payable",
  "function approve(address,uint256) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
];

/**
 * StockTradeRouter: pair-denominated buy/sell through the coin's own v4 pool.
 * The pair here is WETH (a regular ERC-20 the holder gets by wrapping ETH), so
 * this runs fully on a fork; on Base the pair is USDC or a tokenized stock, and
 * the router code path is identical. Coins are MockB20 (the real B-20 precompile
 * cannot run on a fork).
 */
describe("StockTradeRouter: pair-denominated coin<->pair trading (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("buys a coin with its pair token and sells it back", async () => {
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

    const factory = await (await ethers.getContractFactory("StockFlyFactoryV2")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, await b20f.getAddress(), await vd.getAddress(), keeper.address, 4000n * 10n ** 8n,
    );
    await factory.waitForDeployment();
    expect((await factory.getAddress()).toLowerCase()).to.equal(predictedFactory.toLowerCase());

    // Launch a coin paired with WETH (stands in for USDC/stock on Base).
    const p = { name: "Alpha", symbol: "ALPHA", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8, burnBps: 0, liquidityBps: 0 };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);

    // Deploy the pair-denominated router.
    const router = await (await ethers.getContractFactory("StockTradeRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH);
    await router.waitForDeployment();
    const routerAddr = await router.getAddress();

    // --- Pair-denominated path: holder gets WETH, approves, buys/sells. ---
    const weth = await ethers.getContractAt(wethAbi, WETH);
    await (await weth.connect(holder).deposit({ value: ethers.parseEther("0.1") })).wait();
    await (await weth.connect(holder).approve(routerAddr, ethers.MaxUint256)).wait();

    await (await router.connect(holder).buy(coin, ethers.parseEther("0.05"), 0)).wait();
    const bought = (await erc.balanceOf(holder.address)) as bigint;
    expect(bought, "received coin from a pair buy").to.be.greaterThan(0n);

    await (await erc.connect(holder).approve(routerAddr, ethers.MaxUint256)).wait();
    const wethBefore = (await weth.balanceOf(holder.address)) as bigint;
    await (await router.connect(holder).sell(coin, bought, 0)).wait();
    const wethAfter = (await weth.balanceOf(holder.address)) as bigint;
    expect(wethAfter - wethBefore, "sell returned the pair token").to.be.greaterThan(0n);
    expect(await erc.balanceOf(holder.address), "coin fully spent").to.equal(0n);

    // --- Native ETH path: one-tap buy with ETH, sell back to ETH. ---
    const ethBefore = await ethers.provider.getBalance(holder.address);
    await (await router.connect(holder).buyWithEth(coin, 0, { value: ethers.parseEther("0.03") })).wait();
    const bought2 = (await erc.balanceOf(holder.address)) as bigint;
    expect(bought2, "received coin from an ETH buy").to.be.greaterThan(0n);
    await (await erc.connect(holder).approve(routerAddr, ethers.MaxUint256)).wait();
    await (await router.connect(holder).sellForEth(coin, bought2, 0)).wait();
    const ethAfter = await ethers.provider.getBalance(holder.address);
    // Round trip returns ETH (net of gas + fee it will be a bit less than spent).
    expect(ethAfter, "ETH sell paid out").to.be.greaterThan(ethBefore - ethers.parseEther("0.031"));
    expect(await erc.balanceOf(holder.address), "coin fully spent again").to.equal(0n);
  });
});
