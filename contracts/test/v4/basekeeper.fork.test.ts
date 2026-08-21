import { expect } from "chai";
import { ethers } from "hardhat";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

const POOL_MANAGER = "0x498581fF718922c3f8e6A244956aF099B2652b2b";
const WETH = "0x4200000000000000000000000000000000000006";
const V3_ROUTER = "0x2626664C2603336E57b271C5c0b26F421741E10E";
const HOOK_FLAGS = (1n << 13n) | (1n << 6n) | (1n << 2n);
const FLAG_MASK = (1n << 14n) - 1n;
const ETH_USD_8 = 3000n * 10n ** 8n;

// Proves the exact reward pipeline the base keeper drives on V3 coins:
// convert the vault's coin balance into the stock, snapshot holders, build an
// OpenZeppelin StandardMerkleTree of [index, account, amount] leaves, post it,
// and let each holder claim with a real multi-leaf proof. This locks the
// keeper's leaf/tree encoding to the on-chain MerkleProof verification.
describe("Base reward keeper: multi-holder Merkle payout (fork)", function () {
  this.timeout(600_000);
  if (process.env.FORK !== "1") { it.skip("requires FORK=1", () => {}); return; }

  it("converts, posts a StandardMerkleTree epoch, and pays holders by proof", async () => {
    const [admin, creator, holderA, keeper, holderB] = await ethers.getSigners();

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
    const router = await (await ethers.getContractFactory("FlyRouter")).deploy(
      POOL_MANAGER, await factory.getAddress(), WETH, V3_ROUTER,
    );
    await router.waitForDeployment();
    const weth = await ethers.getContractAt("MockB20", WETH);

    const p = { name: "Alpha", symbol: "ALPHA", metadataURI: "", pair: WETH, feeRecipient: ethers.ZeroAddress, pairUsdPrice8: ETH_USD_8 };
    await (await factory.connect(creator).launch(p, ethers.hexlify(ethers.randomBytes(32)))).wait();
    const coin = await factory.allTokens(0n);
    const erc = await ethers.getContractAt("MockB20", coin);
    const vaultAddr = await factory.rewardVaultOf(coin);
    const vault = await ethers.getContractAt("StockRewardVault", vaultAddr);

    // Two holders buy (leaving coin balances), and trades fund the vault.
    await (await router.connect(holderA).buy(coin, "0x", 0, { value: ethers.parseEther("0.05") })).wait();
    await (await router.connect(holderB).buy(coin, "0x", 0, { value: ethers.parseEther("0.03") })).wait();
    // A sell pushes stock-side fees into the vault too.
    await (await erc.connect(holderA).approve(await router.getAddress(), ethers.MaxUint256)).wait();
    await (await router.connect(holderA).sell(coin, (await erc.balanceOf(holderA.address)) / 2n, "0x", 0)).wait();

    // Keeper converts the vault's coin balance to the stock (WETH here).
    if ((await erc.balanceOf(vaultAddr)) > 0n) await (await vault.connect(keeper).convert(0)).wait();
    const budget = await vault.distributable();
    expect(budget, "vault holds distributable reward").to.be.greaterThan(0n);

    // Snapshot the two holders' coin balances and split the budget pro-rata,
    // exactly as the keeper will (floor division; remainder rolls to next epoch).
    const balA = await erc.balanceOf(holderA.address);
    const balB = await erc.balanceOf(holderB.address);
    const total = balA + balB;
    const amtA = (budget * balA) / total;
    const amtB = (budget * balB) / total;
    expect(amtA, "holder A share > 0").to.be.greaterThan(0n);
    expect(amtB, "holder B share > 0").to.be.greaterThan(0n);

    const values = [
      [0, holderA.address, amtA.toString()],
      [1, holderB.address, amtB.toString()],
    ];
    const tree = StandardMerkleTree.of(values, ["uint256", "address", "uint256"]);
    await (await vault.connect(keeper).postEpoch(tree.root, amtA + amtB)).wait();

    // Each holder claims with a real multi-leaf proof.
    const aBefore = await weth.balanceOf(holderA.address);
    await (await vault.connect(holderA).claim(0, 0, holderA.address, amtA, tree.getProof(0))).wait();
    expect((await weth.balanceOf(holderA.address)) - aBefore, "A earned exact share").to.equal(amtA);

    const bBefore = await weth.balanceOf(holderB.address);
    await (await vault.connect(holderB).claim(0, 1, holderB.address, amtB, tree.getProof(1))).wait();
    expect((await weth.balanceOf(holderB.address)) - bBefore, "B earned exact share").to.equal(amtB);

    // A forged proof / wrong amount is rejected.
    await expect(vault.connect(holderA).claim(0, 0, holderA.address, amtA, tree.getProof(1))).to.be.reverted;
  });
});
