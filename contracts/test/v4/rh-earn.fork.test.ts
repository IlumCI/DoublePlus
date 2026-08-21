import { expect } from "chai";
import { ethers } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;

describe("RhEarn launch-to-earn: 80% creator / 20% holders (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("pays the creator the majority of fees in the pair token", async () => {
    const [admin, creator, trader] = await ethers.getSigners();

    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();
    const Hook = await ethers.getContractFactory("RhEarnHook");
    const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(["address", "address"], [POOL_MANAGER, admin.address]);
    const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 500_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    await (await c2.deploy(salt, hookInit)).wait();
    const hook = await ethers.getContractAt("RhEarnHook", hookAddr);

    const factory = await (await ethers.getContractFactory("RhFinalFactory")).deploy(admin.address, admin.address, POOL_MANAGER, hookAddr);
    await factory.waitForDeployment();
    await (await hook.setFactory(await factory.getAddress())).wait();
    const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
    await router.waitForDeployment();

    const Token = await ethers.getContractFactory("QuiverToken");
    const fAddr = await factory.getAddress();
    const params = { name: "Earn", symbol: "EARN", metadataURI: "", pair: WETH, taxBps: 300, pairUsdPrice8: ETH_USD_8 };
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      ["Earn", "EARN", "", 10n ** 27n, creator.address, fAddr, 300, WETH],
    );
    const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    let tsalt = "";
    for (let i = 0n; i < 4_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      if ((BigInt(ethers.getCreate2Address(fAddr, s, hash)) & 0xffffn) === 0x4663n) { tsalt = s; break; }
    }
    await (await factory.connect(creator).launch(params, tsalt)).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const weth = await ethers.getContractAt("QuiverToken", WETH);

    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.03") })).wait();
    const held = await erc.balanceOf(trader.address);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 4n, "0x", 0)).wait();

    const creatorBefore = await weth.balanceOf(creator.address);
    await (await hook.harvest(coin)).wait();
    const creatorGot = (await weth.balanceOf(creator.address)) - creatorBefore;
    const holdersGot = await erc.totalRewardsDistributed();
    expect(creatorGot, "creator paid").to.be.greaterThan(0n);
    expect(holdersGot, "holders paid").to.be.greaterThan(0n);
    // 80/20 in the creator's favour (allowing rounding).
    expect(creatorGot, "creator gets ~4x the holder share").to.be.greaterThan(holdersGot * 3n);
    expect(await erc.pendingRewards(trader.address)).to.be.greaterThan(0n);
  });
});
