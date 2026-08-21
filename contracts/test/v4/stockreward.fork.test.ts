import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

describe("StockRewardVault: hold the coin, earn the pair (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("routes fees to the vault, converts, and pays a holder by merkle proof", async () => {
    const [admin, creator, holder, keeper] = await ethers.getSigners();

    const b20f = await (await ethers.getContractFactory("MockB20Factory")).deploy();
    await b20f.waitForDeployment();
    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();

    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });

    const Hook = await ethers.getContractFactory("StockFeeHook");
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
    const hook = await ethers.getContractAt("StockFeeHook", hookAddr);

    const factory = await (await ethers.getContractFactory("StockFlyFactory")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, await b20f.getAddress(),
    );
    await factory.waitForDeployment();
    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(
      POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
    );
    await router.waitForDeployment();
    const weth = await ethers.getContractAt("MockB20", WETH);

    // Launch a coin against WETH with no burn/liquidity so the whole creator
    // share is payable — half will be redirected to the reward vault.
    const p = { name: "Alpha", symbol: "ALPHA", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8, burnBps: 0, liquidityBps: 0 };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);
    const coinIsC0 = coin.toLowerCase() < WETH.toLowerCase();
    const key = {
      currency0: coinIsC0 ? coin : WETH, currency1: coinIsC0 ? WETH : coin,
      fee: 0, tickSpacing: 60, hooks: hookAddr,
    };

    // Deploy the reward vault (reward token = WETH here; on Base it is the stock).
    const vault = await (await ethers.getContractFactory("StockRewardVault")).deploy(
      POOL_MANAGER, coin, WETH, keeper.address, key, coinIsC0,
    );
    await vault.waitForDeployment();
    const vaultAddr = await vault.getAddress();

    // Redirect half the creator share to the vault (platformAdmin = admin).
    await (await hook.connect(admin).setPayees(key, [
      { to: creator.address, shareBps: 5000 },
      { to: vaultAddr, shareBps: 5000 },
    ])).wait();

    // Trade so fees flow to the vault: coin (from buys) + WETH (from sells).
    await (await router.connect(holder).buy(coin, "0x", 0, { value: ethers.parseEther("0.08") })).wait();
    await (await erc.connect(holder).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(holder).sell(coin, await erc.balanceOf(holder.address), "0x", 0)).wait();

    const vaultCoin = await erc.balanceOf(vaultAddr);
    const vaultWethBefore = await weth.balanceOf(vaultAddr);
    expect(vaultCoin + vaultWethBefore, "vault received fees").to.be.greaterThan(0n);

    // Keeper converts the vault's coin balance into WETH (the reward token).
    if (vaultCoin > 0n) await (await vault.connect(keeper).convert(0)).wait();
    const budget = await vault.distributable();
    expect(budget, "vault holds distributable reward").to.be.greaterThan(0n);

    // Post a single-holder epoch: the leaf IS the root, proof is empty.
    const index = 0n;
    const leaf = ethers.keccak256(
      ethers.concat([ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "address", "uint256"], [index, holder.address, budget]))]),
    );
    await (await vault.connect(keeper).postEpoch(leaf, budget)).wait();

    const holderWethBefore = await weth.balanceOf(holder.address);
    await (await vault.connect(holder).claim(0, index, holder.address, budget, [])).wait();
    expect((await weth.balanceOf(holder.address)) - holderWethBefore, "holder earned the reward").to.equal(budget);

    // No double-claim.
    await expect(vault.connect(holder).claim(0, index, holder.address, budget, [])).to.be.revertedWithCustomError(vault, "AlreadyClaimed");
  });
});
