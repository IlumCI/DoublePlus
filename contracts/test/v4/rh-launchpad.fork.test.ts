import { expect } from "chai";
import { ethers } from "hardhat";

// Live Uniswap V4 PoolManager + wrapped native on Robinhood Chain.
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n); // afterSwap | afterSwapReturnDelta
const FLAG_MASK = (1n << 14n) - 1n;
const PAIR_USD_PRICE_8 = 3000n * 10n ** 8n; // treat the pair (WETH) as ~$3,000

const WETH_ABI = [
  "function deposit() payable",
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];

async function deploy(adminAddr: string, treasury: string, protocolAdmin?: string) {
  const Deployer = await ethers.getContractFactory("HookDeployer");
  const deployer = await Deployer.deploy();
  await deployer.waitForDeployment();
  const deployerAddr = await deployer.getAddress();

  const Hook = await ethers.getContractFactory("RhHook");
  const ctorArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [POOL_MANAGER, adminAddr, treasury],
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
  const hook = await ethers.getContractAt("RhHook", hookAddr);

  const Factory = await ethers.getContractFactory("RhFactory");
  const factory = await Factory.deploy(adminAddr, protocolAdmin ?? adminAddr, POOL_MANAGER, hookAddr);
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
  params: { name: string; symbol: string; metadataURI: string; pair: string; taxBps: number; pairUsdPrice8: bigint },
) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const factoryAddr = await factory.getAddress();
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, factoryAddr, params.taxBps, params.pair],
  );
  const initCodeHash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 3_000_000n; i++) {
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

function poolKeyFor(token: string, pair: string, hookAddr: string) {
  const tokenIsC0 = BigInt(token) < BigInt(pair);
  return {
    key: {
      currency0: tokenIsC0 ? token : pair,
      currency1: tokenIsC0 ? pair : token,
      fee: 0,
      tickSpacing: 60,
      hooks: hookAddr,
    },
    buyZeroForOne: !tokenIsC0, // spend the pair token: zeroForOne when pair is currency0
  };
}

describe("Robinhood V4 fork launchpad (fork)", function () {
  this.timeout(600_000);

  if (process.env.FORK !== "1") {
    it.skip("requires FORK=1 to run against the Robinhood Chain fork", () => {});
    return;
  }

  it("pairs against the chosen token, taxes trades, and pays 80/20 in that token", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { hook, factory, router, hookAddr } = await deploy(admin.address, admin.address);

    // Pair (and reward) is WETH; any-pair is on by default so no listing needed.
    await (
      await launchToken(factory, admin, {
        name: "Fork Test",
        symbol: "FORK",
        metadataURI: "",
        pair: WETH,
        taxBps: 500,
        pairUsdPrice8: PAIR_USD_PRICE_8,
      })
    ).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);
    expect(await erc20.rewardToken()).to.equal(WETH);
    expect(await erc20.balanceOf(POOL_MANAGER)).to.be.greaterThan((10n ** 27n * 99n) / 100n);

    const { key, buyZeroForOne } = poolKeyFor(token, WETH, hookAddr);
    const weth = new ethers.Contract(WETH, WETH_ABI, trader);
    await (await weth.deposit({ value: ethers.parseEther("2") })).wait();
    await (await weth.approve(await router.getAddress(), ethers.MaxUint256)).wait();

    // Buy (fee on the token side), then sell part (fee on the pair side).
    await (await router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("0.01"), trader.address)).wait();
    const held = await erc20.balanceOf(trader.address);
    expect(held).to.be.greaterThan(0n);
    expect(await hook.tokenFees(token)).to.be.greaterThan(0n);
    await (await erc20.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).swapExactIn(key, !buyZeroForOne, held / 5n, trader.address)).wait();
    expect(await hook.pairFees(token)).to.be.greaterThan(0n);

    // Harvest: token fees convert to WETH, 80% to holders, 20% to platform.
    const wethAdmin = new ethers.Contract(WETH, WETH_ABI, admin);
    const platformBefore = await wethAdmin.balanceOf(admin.address);
    await (await hook.harvest(token)).wait();

    expect(await erc20.totalRewardsDistributed(), "80% distributed to holders").to.be.greaterThan(0n);
    expect(await wethAdmin.balanceOf(admin.address) - platformBefore, "20% to platform").to.be.greaterThan(0n);

    // Holder claims their WETH reward.
    const pending = await erc20.pendingRewards(trader.address);
    expect(pending, "holder has a pending reward").to.be.greaterThan(0n);
    const before = await weth.balanceOf(trader.address);
    await (await erc20.connect(trader).claim()).wait();
    expect(await weth.balanceOf(trader.address) - before, "holder claimed the pair token").to.be.greaterThan(0n);
  });

  it("keeper pushes rewards to holder wallets via claimForMany", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { hook, factory, router, hookAddr } = await deploy(admin.address, admin.address);
    await (
      await launchToken(factory, admin, {
        name: "Push", symbol: "PUSH", metadataURI: "", pair: WETH, taxBps: 500, pairUsdPrice8: PAIR_USD_PRICE_8,
      })
    ).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);

    const { key, buyZeroForOne } = poolKeyFor(token, WETH, hookAddr);
    const weth = new ethers.Contract(WETH, WETH_ABI, trader);
    await (await weth.deposit({ value: ethers.parseEther("1") })).wait();
    await (await weth.approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("0.01"), trader.address)).wait();
    await (await hook.harvest(token)).wait();
    expect(await erc20.pendingRewards(trader.address)).to.be.greaterThan(0n);

    // The keeper (admin) pushes; the holder signs and pays nothing.
    const before = await weth.balanceOf(trader.address);
    await (await erc20.connect(admin).claimForMany([trader.address])).wait();
    expect(await weth.balanceOf(trader.address) - before, "reward pushed to holder").to.be.greaterThan(0n);
    expect(await erc20.pendingRewards(trader.address), "pending drained").to.equal(0n);
  });

  it("enforces the allowlist when the any-pair toggle is off", async () => {
    const [admin] = await ethers.getSigners();
    const { factory } = await deploy(admin.address, admin.address);
    await (await factory.setAnyPairEnabled(false)).wait();

    // Unlisted pair now reverts.
    await expect(
      launchToken(factory, admin, { name: "No", symbol: "NO", metadataURI: "", pair: WETH, taxBps: 500, pairUsdPrice8: PAIR_USD_PRICE_8 }),
    ).to.be.revertedWithCustomError(factory, "PairNotAllowed");

    // Listing it makes the launch succeed.
    await (await factory.listPair(WETH)).wait();
    await (
      await launchToken(factory, admin, { name: "Yes", symbol: "YES", metadataURI: "", pair: WETH, taxBps: 500, pairUsdPrice8: PAIR_USD_PRICE_8 })
    ).wait();
    expect(await factory.totalTokens()).to.equal(1n);
  });

  it("keeps protocolAdmin LP unwind working after ownership renounce", async () => {
    const [deployer, trader, padmin] = await ethers.getSigners();
    const { factory, router, hookAddr } = await deploy(deployer.address, deployer.address, padmin.address);

    await (await factory.renounceOwnership()).wait();
    expect(await factory.owner()).to.equal(ethers.ZeroAddress);
    await expect(factory.setLaunchesPaused(true)).to.be.reverted;

    // Launching still works after renounce (any-pair on by default).
    await (
      await launchToken(factory, deployer, { name: "Rnc", symbol: "RNC", metadataURI: "", pair: WETH, taxBps: 500, pairUsdPrice8: PAIR_USD_PRICE_8 })
    ).wait();
    const token = await factory.allTokens(0);
    const erc20 = await ethers.getContractAt("QuiverToken", token);

    const { key, buyZeroForOne } = poolKeyFor(token, WETH, hookAddr);
    const weth = new ethers.Contract(WETH, WETH_ABI, trader);
    await (await weth.deposit({ value: ethers.parseEther("1") })).wait();
    await (await weth.approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).swapExactIn(key, buyZeroForOne, ethers.parseEther("0.02"), trader.address)).wait();

    await expect(factory.connect(trader).unwindPosition(token, 10_000, trader.address)).to.be.revertedWithCustomError(factory, "NotProtocolAdmin");

    const wethC = new ethers.Contract(WETH, WETH_ABI, deployer);
    const wethBefore = await wethC.balanceOf(padmin.address);
    await (await factory.connect(padmin).unwindPosition(token, 10_000, padmin.address)).wait();
    expect(await erc20.balanceOf(padmin.address), "admin got tokens").to.be.greaterThan(0n);
    expect(await wethC.balanceOf(padmin.address), "admin got pair token").to.be.greaterThan(wethBefore);
    expect((await factory.positions(token)).liquidity).to.equal(0n);
  });
});
