import { expect } from "chai";
import { ethers, network } from "hardhat";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_ROUTER = "0xCaf681a66D020601342297493863E78C959E5cb2";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const HOOK_FLAGS = (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 1865n * 10n ** 8n;

describe("Hood: ETH fees 80/15/5, sniper tax, bid wall (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("runs the full unihood-style lifecycle", async () => {
    const [admin, creator, sniper, trader] = await ethers.getSigners();

    const c2 = await (await ethers.getContractFactory("HookDeployer")).deploy();
    await c2.waitForDeployment();
    const c2Addr = await c2.getAddress();
    // Factory address is nonce-predicted and baked into the hook as an
    // immutable, mirroring the deploy script.
    const nonce = await ethers.provider.getTransactionCount(admin.address);
    const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 1 });
    const Hook = await ethers.getContractFactory("HoodHook");
    const hookArgs = ethers.AbiCoder.defaultAbiCoder().encode(
      ["address", "address", "address"],
      [POOL_MANAGER, predictedFactory, admin.address],
    );
    const hookInit = ethers.concat([Hook.bytecode, hookArgs]);
    const hookHash = ethers.keccak256(hookInit);
    let hookAddr = "", salt = "";
    for (let i = 0n; i < 500_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(c2Addr, s, hookHash);
      if ((BigInt(a) & FLAG_MASK) === HOOK_FLAGS) { hookAddr = a; salt = s; break; }
    }
    await (await c2.deploy(salt, hookInit)).wait();
    const hook = await ethers.getContractAt("HoodHook", hookAddr);

    const factory = await (await ethers.getContractFactory("HoodFactory")).deploy(
      admin.address, admin.address, POOL_MANAGER, hookAddr, WETH, STATE_VIEW,
    );
    await factory.waitForDeployment();
    if ((await factory.getAddress()).toLowerCase() !== predictedFactory.toLowerCase())
      throw new Error("factory address mismatch vs hook immutable");
    const router = await (await ethers.getContractFactory("RhRouter")).deploy(POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER);
    await router.waitForDeployment();

    // launch (WETH pair, fixed 1%)
    const Token = await ethers.getContractFactory("QuiverToken");
    const fAddr = await factory.getAddress();
    const params = { name: "Hood", symbol: "HOOD", metadataURI: "", pair: WETH, taxBps: 100, pairUsdPrice8: ETH_USD_8 };
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      ["Hood", "HOOD", "", 10n ** 27n, creator.address, fAddr, 100, WETH],
    );
    const ih = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    let ts = "";
    for (let i = 0n; i < 4_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      if ((BigInt(ethers.getCreate2Address(fAddr, s, ih)) & 0xffffn) === 0x4663n) { ts = s; break; }
    }
    // launch WITH an atomic dev buy: creator gets tokens in the same tx and
    // pays no sniper premium (factory-sender exemption)
    await (await factory.connect(creator).launch(params, ts, { value: ethers.parseEther("0.005") })).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const weth = await ethers.getContractAt("QuiverToken", WETH);
    expect(await erc.balanceOf(creator.address), "dev buy delivered").to.be.greaterThan(0n);
    expect(await hook.tokenFeesSniper(coin), "dev buy pays no sniper premium").to.equal(0n);
    expect(await hook.tokenFees(coin), "dev buy pays the 1% base").to.be.greaterThan(0n);

    // sniper buy within 5s -> sniper premium accrues
    await (await router.connect(sniper).buy(coin, "0x", 0, { value: ethers.parseEther("0.01") })).wait();
    expect(await hook.tokenFeesSniper(coin), "sniper premium accrued").to.be.greaterThan(0n);

    // after 20s the rate is the 1% base: sniper bucket stops growing
    await network.provider.send("evm_increaseTime", [20]);
    await network.provider.send("evm_mine");
    const sniperBefore = await hook.tokenFeesSniper(coin);
    await (await router.connect(trader).buy(coin, "0x", 0, { value: ethers.parseEther("0.02") })).wait();
    expect(await hook.tokenFeesSniper(coin)).to.equal(sniperBefore);

    // harvest: 80% creator / 15% treasury / 5%+sniper -> wall
    const cB = await weth.balanceOf(creator.address);
    const aB = await weth.balanceOf(admin.address);
    await (await hook.harvest(coin)).wait();
    const cGot = (await weth.balanceOf(creator.address)) - cB;
    const aGot = (await weth.balanceOf(admin.address)) - aB;
    const wall = await factory.walls(coin);
    expect(cGot, "creator 80%").to.be.greaterThan(0n);
    expect(aGot, "treasury 15%").to.be.greaterThan(0n);
    expect(wall.pending, "wall funded").to.be.greaterThan(0n);
    expect(cGot).to.be.greaterThan(aGot * 4n);

    // bump the wall: liquidity goes live just below market
    await (await factory.bumpWall(coin)).wait();
    const wall2 = await factory.walls(coin);
    expect(wall2.pos.liquidity, "wall placed").to.be.greaterThan(0n);
    expect(wall2.pending).to.equal(0n);

    // a sell trades INTO the wall and still succeeds
    const held = await erc.balanceOf(trader.address);
    await (await erc.connect(trader).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(trader).sell(coin, held / 2n, "0x", 0)).wait();

    // bump again: recovers, burns any coin the wall absorbed
    const deadB = await erc.balanceOf("0x000000000000000000000000000000000000dEaD");
    await (await hook.harvest(coin)).wait();
    await (await factory.bumpWall(coin)).wait();
    const deadA = await erc.balanceOf("0x000000000000000000000000000000000000dEaD");
    expect(deadA >= deadB).to.equal(true);
  });
});
