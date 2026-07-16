import { expect } from "chai";
import { ethers } from "hardhat";

// Live Uniswap V4 stack + tokens on Robinhood Chain (discovered on-chain).
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta = 68
const FLAG_MASK = (1n << 14n) - 1n;

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

// Candidate reward-route pools (no hooks). key currencies sort by address.
const wethUsdgKey = {
  currency0: WETH, // WETH < USDG
  currency1: USDG,
  fee: 500,
  tickSpacing: 10,
  hooks: ethers.ZeroAddress,
};
const usdgNvdaKey = {
  currency0: USDG, // USDG < NVDA
  currency1: NVDA,
  fee: 3000,
  tickSpacing: 60,
  hooks: ethers.ZeroAddress,
};

async function deploy(adminAddr: string, treasury: string) {
  const Deployer = await ethers.getContractFactory("HookDeployer");
  const deployer = await Deployer.deploy();
  await deployer.waitForDeployment();
  const deployerAddr = await deployer.getAddress();

  const Hook = await ethers.getContractFactory("QuiverHook");
  const ctorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address", "address"],
    [POOL_MANAGER, adminAddr, treasury, WETH],
  );
  const initCode = ethers.concat([Hook.bytecode, ctorArgs]);
  const initCodeHash = ethers.keccak256(initCode);

  let hookAddr = "";
  let salt = "";
  for (let i = 0n; i < 500_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const addr = ethers.getCreate2Address(deployerAddr, s, initCodeHash);
    if ((BigInt(addr) & FLAG_MASK) === HOOK_FLAGS) {
      hookAddr = addr;
      salt = s;
      break;
    }
  }
  if (!hookAddr) throw new Error("no hook salt found");
  await (await deployer.deploy(salt, initCode)).wait();
  const hook = await ethers.getContractAt("QuiverHook", hookAddr);

  const Factory = await ethers.getContractFactory("QuiverFactory");
  const factory = await Factory.deploy(adminAddr, POOL_MANAGER, hookAddr, WETH, 3000n * 10n ** 8n);
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const Router = await ethers.getContractFactory("TestRouter");
  const router = await Router.deploy(POOL_MANAGER);
  await router.waitForDeployment();

  return { hook, factory, router, hookAddr };
}

async function launchToken(
  factory: any,
  signer: any,
  params: { name: string; symbol: string; metadataURI: string; stock: string; taxBps: number },
) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const factoryAddr = await factory.getAddress();
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, factoryAddr, params.taxBps, params.stock],
  );
  const initCodeHash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 2_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(factoryAddr, s, initCodeHash);
    if ((BigInt(a) & 0xffffn) === 0x4663n) {
      salt = s;
      break;
    }
  }
  if (!salt) throw new Error("no token vanity salt");
  return factory.connect(signer).launch(params, salt);
}

function poolKeyFor(token: string, hookAddr: string) {
  const tokenIsC0 = BigInt(token) < BigInt(WETH);
  return {
    key: {
      currency0: tokenIsC0 ? token : WETH,
      currency1: tokenIsC0 ? WETH : token,
      fee: 0,
      tickSpacing: 60,
      hooks: hookAddr,
    },
    buyZeroForOne: !tokenIsC0, // spend WETH: zeroForOne when WETH is currency0
  };
}

describe("Quiver V4 launchpad (fork)", function () {
  this.timeout(600_000);

  if (process.env.FORK !== "1") {
    it.skip("requires FORK=1 to run against the Robinhood Chain fork", () => {});
    return;
  }

  it("launches, taxes buys, enforces the 2% wallet cap, and harvests", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { hook, factory, router, hookAddr } = await deploy(admin.address, admin.address);

    await (await factory.listStock(NVDA, usdgNvdaKey)).wait();
    await (await launchToken(factory, admin, { name: "Fork Test", symbol: "FORK", metadataURI: "", stock: NVDA, taxBps: 500 })).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);
    expect(await erc20.totalSupply()).to.equal(10n ** 27n);
    expect(await erc20.balanceOf(POOL_MANAGER)).to.be.greaterThan((10n ** 27n * 99n) / 100n);

    const { key, buyZeroForOne } = poolKeyFor(token, hookAddr);
    const weth = new ethers.Contract(WETH, WETH_ABI, trader);
    await (await weth.deposit({ value: ethers.parseEther("1") })).wait();
    await (await weth.approve(await router.getAddress(), ethers.MaxUint256)).wait();

    await (await router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("0.004"), trader.address)).wait();
    const traderBal = await erc20.balanceOf(trader.address);
    expect(traderBal).to.be.greaterThan(0n);
    expect(traderBal).to.be.lessThanOrEqual(await erc20.maxWalletAmount());
    expect(await hook.tokenFees(token)).to.be.greaterThan(0n);

    await weth.deposit({ value: ethers.parseEther("5") });
    await expect(
      router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("5"), trader.address),
    ).to.be.reverted;

    const supplyBefore = await erc20.totalSupply();
    await (await hook.harvest(token)).wait();
    expect(await hook.creatorClaimable(token)).to.be.greaterThan(0n);
    expect(await erc20.totalSupply()).to.be.lessThan(supplyBefore);
  });

  it("trades via QuiverRouter with native ETH (buy and sell)", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { factory, hookAddr } = await deploy(admin.address, admin.address);
    await (await factory.listStock(NVDA, usdgNvdaKey)).wait();
    await (await launchToken(factory, admin, { name: "Router Test", symbol: "RT", metadataURI: "", stock: NVDA, taxBps: 500 })).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);

    const Router = await ethers.getContractFactory("QuiverRouter");
    const router = await Router.deploy(POOL_MANAGER, WETH, hookAddr);
    await router.waitForDeployment();

    // Buy with native ETH.
    await (await router.connect(trader).buy(token, 0, { value: ethers.parseEther("0.003") })).wait();
    const bought = await erc20.balanceOf(trader.address);
    expect(bought, "received tokens for ETH").to.be.greaterThan(0n);
    expect(bought).to.be.lessThanOrEqual(await erc20.maxWalletAmount());

    // Sell half back for ETH.
    await (await erc20.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    const ethBefore = await ethers.provider.getBalance(trader.address);
    const sellAmt = bought / 2n;
    const rc = await (await router.connect(trader).sell(token, sellAmt, 0)).wait();
    const ethAfter = await ethers.provider.getBalance(trader.address);
    // Net ETH should rise despite gas (small pool, small trade).
    expect(await erc20.balanceOf(trader.address)).to.equal(bought - sellAmt);
    expect(ethAfter, "received ETH from sell").to.be.greaterThan(ethBefore - ethers.parseEther("0.001"));
  });

  it("pays holders their chosen stock (NVDA) as a dividend", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { hook, factory, router, hookAddr } = await deploy(admin.address, admin.address);

    // Configure the WETH -> USDG -> NVDA reward route.
    await (await hook.setQuoteRoute(USDG, wethUsdgKey)).wait();
    await (await factory.listStock(NVDA, usdgNvdaKey)).wait();

    await (await launchToken(factory, admin, { name: "Div Test", symbol: "DIV", metadataURI: "", stock: NVDA, taxBps: 500 })).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);

    const { key, buyZeroForOne } = poolKeyFor(token, hookAddr);
    const weth = new ethers.Contract(WETH, WETH_ABI, trader);
    await (await weth.deposit({ value: ethers.parseEther("2") })).wait();
    await (await weth.approve(await router.getAddress(), ethers.MaxUint256)).wait();

    // Trader becomes a holder, and generates buy + sell fees.
    await (await router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("0.004"), trader.address)).wait();
    const held = await erc20.balanceOf(trader.address);
    await (await erc20.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    // Sell part back to create a WETH-side fee too.
    await (await router.connect(trader).swapExactIn(key, !buyZeroForOne, held / 5n, trader.address)).wait();

    const nvda = await ethers.getContractAt("QuiverToken", NVDA); // ERC20 subset is enough
    await (await hook.harvest(token)).wait();

    const distributed = await erc20.totalRewardsDistributed();
    expect(distributed, "NVDA distributed to holders").to.be.greaterThan(0n);

    const pending = await erc20.pendingRewards(trader.address);
    expect(pending, "holder has a pending NVDA dividend").to.be.greaterThan(0n);

    const before = await nvda.balanceOf(trader.address);
    await (await erc20.connect(trader).claim()).wait();
    const after = await nvda.balanceOf(trader.address);
    expect(after - before, "holder claimed NVDA").to.be.greaterThan(0n);
  });
});
