import { ethers, network } from "hardhat";
import * as fs from "fs";
import * as path from "path";

import UniswapV3FactoryArtifact from "@uniswap/v3-core/artifacts/contracts/UniswapV3Factory.sol/UniswapV3Factory.json";
import SwapRouterArtifact from "@uniswap/swap-router-contracts/artifacts/contracts/SwapRouter02.sol/SwapRouter02.json";
import PositionManagerArtifact from "@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json";

/**
 * Local development stack: deploys WETH, a full Uniswap V3 suite and the
 * launchpad contracts to the target network (meant for a local hardhat node),
 * then launches a demo token and produces a few trades so the indexer and UI
 * have data. Writes deployments/localnet.json for the backend/web env.
 */
async function main() {
  const [admin, creator, alice, bob] = await ethers.getSigners();
  console.log(`Deploying local stack to ${network.name}`);

  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  const uniFactory = await new ethers.ContractFactory(
    UniswapV3FactoryArtifact.abi,
    UniswapV3FactoryArtifact.bytecode,
    admin
  ).deploy();
  const positionManager = await new ethers.ContractFactory(
    PositionManagerArtifact.abi,
    PositionManagerArtifact.bytecode,
    admin
  ).deploy(await uniFactory.getAddress(), await weth.getAddress(), ethers.ZeroAddress);
  const swapRouter = await new ethers.ContractFactory(
    SwapRouterArtifact.abi,
    SwapRouterArtifact.bytecode,
    admin
  ).deploy(
    ethers.ZeroAddress,
    await uniFactory.getAddress(),
    await positionManager.getAddress(),
    await weth.getAddress()
  );

  const tokenFactory = await (await ethers.getContractFactory("TokenFactory")).deploy();
  const treasury = await (await ethers.getContractFactory("Treasury")).deploy(admin.address);
  const feeDistributor = await (await ethers.getContractFactory("FeeDistributor")).deploy(admin.address);

  const launchpad = await (
    await ethers.getContractFactory("Launchpad")
  ).deploy(
    admin.address,
    await tokenFactory.getAddress(),
    await uniFactory.getAddress(),
    await positionManager.getAddress(),
    await swapRouter.getAddress(),
    await weth.getAddress(),
    await feeDistributor.getAddress(),
    await treasury.getAddress(),
    40_000n * 10n ** 8n,
    2_000n * 10n ** 8n // 2,000 USD per native token
  );
  await feeDistributor.setLaunchpad(await launchpad.getAddress());
  await tokenFactory.setLaunchpad(await launchpad.getAddress());

  console.log(`Launchpad: ${await launchpad.getAddress()}`);

  // Demo token with a launch, buys and a sell for indexer/UI development.
  const tx = await launchpad.connect(creator).createToken(
    {
      name: "Demo Rocket",
      symbol: "RKT",
      metadataURI: JSON.stringify({
        description: "Community token for local development and testing",
        logo: "",
        website: "https://example.com",
        twitter: "https://x.com/example",
        telegram: "https://t.me/example",
      }),
    },
    { value: 0n }
  );
  const receipt = await tx.wait();
  const launched = receipt!.logs
    .map((l) => {
      try {
        return launchpad.interface.parseLog(l);
      } catch {
        return null;
      }
    })
    .find((l) => l?.name === "TokenLaunched");
  const token = launched!.args.token as string;
  console.log(`Demo token: ${token}`);

  const deadline = 4_000_000_000n;
  await (await launchpad.connect(alice).buy(token, 0, deadline, { value: ethers.parseEther("0.008") })).wait();
  await (await launchpad.connect(bob).buy(token, 0, deadline, { value: ethers.parseEther("0.006") })).wait();

  const tokenContract = await ethers.getContractAt("LaunchToken", token);
  const bal = await tokenContract.balanceOf(alice.address);
  await (await tokenContract.connect(alice).approve(await launchpad.getAddress(), bal / 4n)).wait();
  await (await launchpad.connect(alice).sell(token, bal / 4n, 0, deadline)).wait();
  console.log("Produced 2 buys and 1 sell");

  const deployment = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployer: admin.address,
    contracts: {
      tokenFactory: await tokenFactory.getAddress(),
      treasury: await treasury.getAddress(),
      feeDistributor: await feeDistributor.getAddress(),
      launchpad: await launchpad.getAddress(),
    },
    uniswap: {
      factory: await uniFactory.getAddress(),
      positionManager: await positionManager.getAddress(),
      swapRouter: await swapRouter.getAddress(),
      weth: await weth.getAddress(),
    },
    demoToken: token,
  };
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "localnet.json"), JSON.stringify(deployment, null, 2));
  console.log("Wrote deployments/localnet.json");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
