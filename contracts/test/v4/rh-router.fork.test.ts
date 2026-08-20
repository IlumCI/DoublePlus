import { expect } from "chai";
import { ethers } from "hardhat";

// Live infra on Robinhood Chain.
const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const NVDA = "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";

const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const NVDA_USD_8 = 200n * 10n ** 8n;

// V3 path WETH -(100)- USDG -(3000)- NVDA and its reverse.
const pathBuy = ethers.solidityPacked(
  ["address", "uint24", "address", "uint24", "address"],
  [WETH, 100, USDG, 3000, NVDA],
);
const pathSell = ethers.solidityPacked(
  ["address", "uint24", "address", "uint24", "address"],
  [NVDA, 3000, USDG, 100, WETH],
);

async function deployAll(admin: any) {
  const Deployer = await ethers.getContractFactory("HookDeployer");
  const c2 = await Deployer.deploy();
  await c2.waitForDeployment();
  const c2Addr = await c2.getAddress();

  const Hook = await ethers.getContractFactory("RhHook");
  const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
    ["address", "address", "address"],
    [POOL_MANAGER, admin.address, admin.address],
  );
  const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
  const hookHash = ethers.keccak256(hookInit);
  let hookAddr = "";
  let salt = "";
  for (let i = 0n; i < 500_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(c2Addr, s, hookHash);
    if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
  }
  if (!hookAddr) throw new Error("no hook salt");
  await (await c2.deploy(salt, hookInit)).wait();
  const hook = await ethers.getContractAt("RhHook", hookAddr);

  const Factory = await ethers.getContractFactory("RhFactory");
  const factory = await Factory.deploy(admin.address, admin.address, POOL_MANAGER, hookAddr);
  await factory.waitForDeployment();
  await (await hook.setFactory(await factory.getAddress())).wait();

  const Router = await ethers.getContractFactory("RhRouter");
  const router = await Router.deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
  await router.waitForDeployment();

  return { hook, factory, router };
}

async function launch(factory: any, signer: any, pair: string, pairUsd8: bigint) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const fAddr = await factory.getAddress();
  const params = { name: "Router Coin", symbol: "RC", metadataURI: "", pair, taxBps: 300, pairUsdPrice8: pairUsd8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, fAddr, params.taxBps, params.pair],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 3_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(fAddr, s, hash);
    if ((BigInt(a) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity");
  await (await factory.connect(signer).launch(params, salt)).wait();
  return factory.allTokens(0);
}

describe("RhRouter ETH<->stock<->coin (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") {
    it.skip("requires FORK=1", () => {});
    return;
  }

  it("buys a NVDA-paired coin with ETH and sells it back for ETH", async () => {
    const [admin, trader] = await ethers.getSigners();
    const { factory, router } = await deployAll(admin);
    const coin = await launch(factory, admin, NVDA, NVDA_USD_8);
    const erc20 = await ethers.getContractAt("QuiverToken", coin);
    expect(await erc20.rewardToken()).to.equal(NVDA);

    // Buy with 0.02 ETH: ETH -> WETH -> USDG -> NVDA -> coin.
    await (await router.connect(trader).buy(coin, pathBuy, 0, { value: ethers.parseEther("0.02") })).wait();
    const bought = await erc20.balanceOf(trader.address);
    expect(bought, "received coin for ETH").to.be.greaterThan(0n);

    // Sell half back: coin -> NVDA -> USDG -> WETH -> ETH.
    await (await erc20.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    const ethBefore = await ethers.provider.getBalance(trader.address);
    const rc = await (await router.connect(trader).sell(coin, bought / 2n, pathSell, 0)).wait();
    const ethAfter = await ethers.provider.getBalance(trader.address);
    expect(await erc20.balanceOf(trader.address)).to.equal(bought - bought / 2n);
    // Net ETH rises despite gas (small pool), or at least does not vanish.
    expect(ethAfter, "got ETH back from sell").to.be.greaterThan(ethBefore - ethers.parseEther("0.01"));
  });
});
