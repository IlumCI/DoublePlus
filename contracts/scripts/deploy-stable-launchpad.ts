import { ethers, network } from "hardhat";
import { writeFileSync } from "fs";
import { join } from "path";

/**
 * StableLaunchpadFactory deployment — Stable Mainnet (chain 988, gas = USDT0).
 *
 * Uses the OFFICIAL Uniswap V3 deployment and wrapped native on Stable,
 * supplied via env. If Stable has no official Uniswap V3 yet, deploy the
 * canonical stack first with scripts/deploy-uniswap-stack.ts and pass those
 * addresses here.
 *
 * Env:
 *   UNIV3_FACTORY        official Uniswap V3 factory address       (required)
 *   POSITION_MANAGER     official NonfungiblePositionManager       (required)
 *   SWAP_ROUTER          official SwapRouter / SwapRouter02        (required)
 *   WRAPPED_NATIVE       official wrapped native token (WUSDT0)    (required)
 *   FACTORY_OWNER        factory owner — the only privileged account (required)
 *   FEE_RECIPIENT        platform fee recipient (default: FACTORY_OWNER)
 *   QUOTE_STABLES        comma-separated extra $1.00 quote assets  (optional)
 *
 *   npx hardhat run scripts/deploy-stable-launchpad.ts --network stable
 */
async function main() {
  const [signer] = await ethers.getSigners();

  const req = (name: string): string => {
    const v = process.env[name];
    if (!v) throw new Error(`Set ${name}`);
    return v;
  };
  const uniFactory = req("UNIV3_FACTORY");
  const positionManager = req("POSITION_MANAGER");
  const swapRouter = req("SWAP_ROUTER");
  const wrappedNative = req("WRAPPED_NATIVE");
  const owner = req("FACTORY_OWNER");
  const feeRecipient = process.env.FEE_RECIPIENT ?? owner;

  console.log("network:", network.name, "| deployer:", signer.address);
  console.log("owner:", owner, "| feeRecipient:", feeRecipient);

  // 1. Token deployer (holds the ERC20 bytecode, bound to the factory once).
  const TokenDeployer = await ethers.getContractFactory("TokenDeployer");
  const tokenDeployer = await TokenDeployer.deploy();
  await tokenDeployer.waitForDeployment();
  console.log("TokenDeployer:", await tokenDeployer.getAddress());

  // 2. The factory itself.
  const Factory = await ethers.getContractFactory("StableLaunchpadFactory");
  const factory = await Factory.deploy(
    owner,
    feeRecipient,
    await tokenDeployer.getAddress(),
    uniFactory,
    positionManager,
    swapRouter,
    wrappedNative,
  );
  await factory.waitForDeployment();
  const factoryAddr = await factory.getAddress();
  console.log("StableLaunchpadFactory:", factoryAddr);

  // 3. One-time wiring: only the factory can mint tokens.
  await (await tokenDeployer.setFactory(factoryAddr)).wait();

  // 4. Optional extra $1.00 stable quote assets. Requires the deployer to be
  //    the owner; otherwise run setQuoteAsset from the owner wallet.
  const stables = (process.env.QUOTE_STABLES ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of stables) {
    if (signer.address.toLowerCase() === owner.toLowerCase()) {
      await (await factory.setQuoteAsset(s, true, 100_000_000n)).wait();
      console.log("approved quote:", s);
    } else {
      console.log(`owner action needed: factory.setQuoteAsset(${s}, true, 1e8)`);
    }
  }

  const out = {
    network: network.name,
    chainId: Number(process.env.STABLE_CHAIN_ID ?? 988),
    startBlock: await ethers.provider.getBlockNumber(),
    deployer: signer.address,
    owner,
    feeRecipient,
    uniswapV3: { factory: uniFactory, positionManager, swapRouter, wrappedNative },
    contracts: {
      tokenDeployer: await tokenDeployer.getAddress(),
      factory: factoryAddr,
    },
    config: {
      totalSupply: "1000000000e18",
      poolFeeTier: 10000,
      creatorFeeBps: 8000,
      platformFeeBps: 2000,
      defaultMarketCapUsd: 3000,
    },
  };
  const path = join(__dirname, "../deployments/stable-launchpad.json");
  writeFileSync(path, JSON.stringify(out, null, 2));
  console.log("saved", path);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
