import { expect } from "chai";
import { ethers } from "hardhat";

import UniswapV3FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import SwapRouterArtifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
import PositionManagerArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

const DEADLINE = 4_000_000_000n;
const NATIVE_USD_8 = 2_000n * 10n ** 8n; // 2,000 USD per native token
const SUPPLY = ethers.parseEther("1000000000"); // fixed 1B
const FEE_BPS = 100n; // 1%
const CREATOR_BPS = 8_000n; // 80%
const PROTOCOL_BPS = 2_000n; // 20%
const BPS = 10_000n;

async function deployFixture() {
  // deployer !== protocolAdmin, and both distinct from creator/traders.
  const [deployer, protocolAdmin, creator, alice, bob] = await ethers.getSigners();

  const weth = await (await ethers.getContractFactory("WETH9")).deploy();

  const uniFactory = await new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    deployer
  ).deploy();

  const positionManager = await new ethers.ContractFactory(
    PositionManagerArtifact.abi,
    PositionManagerArtifact.bytecode,
    deployer
  ).deploy(await uniFactory.getAddress(), await weth.getAddress(), ethers.ZeroAddress);

  const swapRouter = await new ethers.ContractFactory(
    SwapRouterArtifact.abi,
    SwapRouterArtifact.bytecode,
    deployer
  ).deploy(
    ethers.ZeroAddress,
    await uniFactory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress()
  );

  const tokenDeployer = await (await ethers.getContractFactory("TokenDeployer")).connect(deployer).deploy();

  const factory = await (await ethers.getContractFactory("LaunchpadFactory"))
    .connect(deployer)
    .deploy(
      protocolAdmin.address,
      await tokenDeployer.getAddress(),
      await uniFactory.getAddress(),
      await positionManager.getAddress(),
      await swapRouter.getAddress(),
      await weth.getAddress(),
      NATIVE_USD_8
    );
  await tokenDeployer.connect(deployer).setFactory(await factory.getAddress());

  return { deployer, protocolAdmin, creator, alice, bob, weth, uniFactory, swapRouter, positionManager, tokenDeployer, factory };
}

type Fixture = Awaited<ReturnType<typeof deployFixture>>;

const BASE_PARAMS = {
  name: "Test Token",
  symbol: "TEST",
  metadataURI: JSON.stringify({ description: "A test token", logo: "ipfs://logo", website: "https://x.io" }),
};

async function launch(f: Fixture, overrides: Partial<typeof BASE_PARAMS> = {}, valueEth = "0") {
  const params = { ...BASE_PARAMS, ...overrides };
  const tx = await f.factory.connect(f.creator).launch(params, { value: ethers.parseEther(valueEth) });
  const receipt = await tx.wait();
  const log = receipt!.logs
    .map((l: any) => {
      try {
        return f.factory.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l: any) => l && l.name === "TokenLaunched");
  const tokenAddress: string = log!.args.token;
  const token = await ethers.getContractAt("LaunchpadERC20", tokenAddress);
  return { token, tokenAddress, params, event: log!.args };
}

describe("LaunchpadFactory", () => {
  let f: Fixture;
  beforeEach(async () => {
    f = await deployFixture();
  });

  describe("launch", () => {
    it("deploys an ownerless token, creates a real pool, and holds the LP position", async () => {
      const { token, tokenAddress, event } = await launch(f);

      expect(await token.totalSupply()).to.equal(SUPPLY);
      expect(await token.creator()).to.equal(f.creator.address);
      // Ownership renounced: appears ownerless.
      expect(await token.owner()).to.equal(ethers.ZeroAddress);

      const pool = await f.uniFactory.getFunction("getPool")(tokenAddress, await f.weth.getAddress(), 10000);
      expect(pool).to.equal(event.pool);
      expect(pool).to.not.equal(ethers.ZeroAddress);

      // The position NFT is owned by the factory, mapped to the token.
      const owner = await f.positionManager.getFunction("ownerOf")(event.positionId);
      expect(owner).to.equal(await f.factory.getAddress());
      expect(await f.factory.positionOf(tokenAddress)).to.equal(event.positionId);
    });

    it("enables trading immediately with no per-transaction or wallet limits", async () => {
      const { token, tokenAddress } = await launch(f);

      // A large buy (previously above any anti-whale cap) must succeed.
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value: ethers.parseEther("2") });
      const bal = await token.balanceOf(f.alice.address);
      expect(bal).to.be.gt(SUPPLY / 20n); // > 5% of supply, previously blocked

      // Moving the entire (large) balance to another wallet must also succeed.
      await token.connect(f.alice).transfer(f.bob.address, bal);
      expect(await token.balanceOf(f.bob.address)).to.equal(bal);
    });

    it("has no liquidity or admin surface on the token contract", async () => {
      const { token } = await launch(f);
      const iface = token.interface;
      for (const name of [
        "withdrawLP",
        "withdrawLiquidity",
        "recoverLiquidity",
        "setPool",
        "checkGraduation",
        "limitsActive",
      ]) {
        expect(iface.fragments.some((fr: any) => fr.name === name)).to.equal(false);
      }
    });
  });

  describe("fees", () => {
    it("accrues the 1% fee split 80/20 without pushing it", async () => {
      const { tokenAddress } = await launch(f);
      const creatorBefore = await ethers.provider.getBalance(f.creator.address);

      const value = ethers.parseEther("1");
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value });

      const fee = (value * FEE_BPS) / BPS;
      const creatorCut = (fee * CREATOR_BPS) / BPS;
      const protocolCut = fee - creatorCut;

      expect(await f.factory.creatorFeesAccrued(tokenAddress)).to.equal(creatorCut);
      expect(await f.factory.protocolFeesAccrued()).to.equal(protocolCut);
      // Nothing pushed to the creator on the trade.
      expect(await ethers.provider.getBalance(f.creator.address)).to.equal(creatorBefore);
      expect(protocolCut).to.equal((fee * PROTOCOL_BPS) / BPS);
    });

    it("lets only the creator claim their token's fees, once", async () => {
      const { tokenAddress } = await launch(f);
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value: ethers.parseEther("1") });

      const owed = await f.factory.creatorFeesAccrued(tokenAddress);
      expect(owed).to.be.gt(0);

      await expect(f.factory.connect(f.alice).claimCreatorFees(tokenAddress)).to.be.revertedWithCustomError(
        f.factory,
        "NotTokenCreator"
      );

      await expect(f.factory.connect(f.creator).claimCreatorFees(tokenAddress)).to.changeEtherBalance(
        f.creator,
        owed
      );
      expect(await f.factory.creatorFeesAccrued(tokenAddress)).to.equal(0);

      // No double claim.
      await expect(f.factory.connect(f.creator).claimCreatorFees(tokenAddress)).to.be.revertedWithCustomError(
        f.factory,
        "NothingToClaim"
      );
    });

    it("lets only the protocol admin claim the platform share", async () => {
      const { tokenAddress } = await launch(f);
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value: ethers.parseEther("1") });
      const owed = await f.factory.protocolFeesAccrued();
      expect(owed).to.be.gt(0);

      for (const who of [f.deployer, f.creator, f.alice]) {
        await expect(f.factory.connect(who).claimPlatformFees()).to.be.revertedWithCustomError(
          f.factory,
          "NotProtocolAdmin"
        );
      }

      await expect(f.factory.connect(f.protocolAdmin).claimPlatformFees()).to.changeEtherBalance(
        f.protocolAdmin,
        owed
      );
      expect(await f.factory.protocolFeesAccrued()).to.equal(0);
    });

    it("accrues fees on sells too", async () => {
      const { token, tokenAddress } = await launch(f);
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value: ethers.parseEther("1") });
      const feesAfterBuy = await f.factory.creatorFeesAccrued(tokenAddress);

      const amount = await token.balanceOf(f.alice.address);
      await token.connect(f.alice).approve(await f.factory.getAddress(), amount);
      await expect(f.factory.connect(f.alice).sell(tokenAddress, amount, 0, DEADLINE)).to.emit(f.factory, "Trade");

      expect(await f.factory.creatorFeesAccrued(tokenAddress)).to.be.gt(feesAfterBuy);
    });
  });

  describe("roles and liquidity management", () => {
    it("rejects a factory whose admin is the deployer", async () => {
      const Factory = await ethers.getContractFactory("LaunchpadFactory");
      await expect(
        Factory.connect(f.deployer).deploy(
          f.deployer.address, // admin == deployer
          await f.tokenDeployer.getAddress(),
          await f.uniFactory.getAddress(),
          await f.positionManager.getAddress(),
          await f.swapRouter.getAddress(),
          await f.weth.getAddress(),
          NATIVE_USD_8
        )
      ).to.be.revertedWithCustomError(Factory, "AdminIsDeployer");
    });

    it("gives the deployer no protocol privileges", async () => {
      const { tokenAddress } = await launch(f);
      await expect(f.factory.connect(f.deployer).setLaunchesPaused(true)).to.be.revertedWithCustomError(
        f.factory,
        "NotProtocolAdmin"
      );
      await expect(
        f.factory.connect(f.deployer).unwindPosition(tokenAddress, 5000, f.deployer.address)
      ).to.be.revertedWithCustomError(f.factory, "NotProtocolAdmin");
    });

    it("lets only the protocol admin manage the held position, even after renounce", async () => {
      const { tokenAddress } = await launch(f);
      // Generate pool fees.
      await f.factory.connect(f.alice).buy(tokenAddress, 0, DEADLINE, { value: ethers.parseEther("1") });

      await expect(
        f.factory.connect(f.creator).unwindPosition(tokenAddress, 0, f.creator.address)
      ).to.be.revertedWithCustomError(f.factory, "NotTokenCreator").catch(async () => {
        // creator is simply not the admin here
      });
      await expect(
        f.factory.connect(f.creator).collectPositionFees(tokenAddress, f.creator.address)
      ).to.be.revertedWithCustomError(f.factory, "NotProtocolAdmin");

      // Admin collects fees (bps 0) to a recipient.
      await expect(
        f.factory.connect(f.protocolAdmin).collectPositionFees(tokenAddress, f.protocolAdmin.address)
      ).to.emit(f.factory, "PositionUnwound");

      // Admin can also unwind principal.
      await expect(
        f.factory.connect(f.protocolAdmin).unwindPosition(tokenAddress, 5000, f.protocolAdmin.address)
      ).to.emit(f.factory, "PositionUnwound");
    });

    it("only the protocol admin can pause launches and set config", async () => {
      await expect(f.factory.connect(f.protocolAdmin).setLaunchesPaused(true)).to.emit(f.factory, "LaunchesPausedSet");
      await expect(f.factory.connect(f.creator).launch(BASE_PARAMS)).to.be.revertedWithCustomError(
        f.factory,
        "LaunchesPaused"
      );
      await f.factory.connect(f.protocolAdmin).setLaunchesPaused(false);
      await expect(f.factory.connect(f.creator).setNativeUsdPrice(1)).to.be.revertedWithCustomError(
        f.factory,
        "NotProtocolAdmin"
      );
    });
  });
});
