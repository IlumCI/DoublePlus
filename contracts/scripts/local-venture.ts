// Spin the full venture stack on a local node and open one Guaranteed raise
// with a live curve position, so the raise-phase UI (buy + sell back) can be
// driven for real. Pool seeding is never reached, so the placeholder
// poolManager/v3Router are fine — same arrangement the unit tests use.
import { ethers } from "hardhat";

const ETH_USD_8 = 1865n * 10n ** 8n;
const DAY = 86_400;

async function mineSalt(tokenDeployer: any, args: any[]) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address", "uint256", "uint8"], args,
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, encoded]));
  const depAddr = await tokenDeployer.getAddress();
  for (let i = 0n; i < 6_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(depAddr, s, hash)) & 0xffffn) === 0x4663n) return s;
  }
  throw new Error("no vanity salt");
}

async function main() {
  const [admin, creator, buyer] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  await weth.waitForDeployment();
  const placeholder = await weth.getAddress();

  const vestingDeployer = await (await ethers.getContractFactory("VestingDeployer")).deploy();
  await vestingDeployer.waitForDeployment();
  const nonce = await ethers.provider.getTransactionCount(admin.address);
  const predictedFactory = ethers.getCreateAddress({ from: admin.address, nonce: nonce + 2 });
  const hook = await (await ethers.getContractFactory("VentureFeeHook")).deploy(
    placeholder, admin.address, predictedFactory, 100, 2000,
  );
  await hook.waitForDeployment();
  const tokenDeployer = await (await ethers.getContractFactory("VentureTokenDeployer")).deploy(predictedFactory);
  await tokenDeployer.waitForDeployment();
  const factory = await (await ethers.getContractFactory("VentureFactory")).deploy(
    admin.address, admin.address, placeholder, await hook.getAddress(), placeholder, placeholder,
    await vestingDeployer.getAddress(), await tokenDeployer.getAddress(), 50, 100, 1n,
  );
  await factory.waitForDeployment();
  const router = await (await ethers.getContractFactory("VentureRouter")).deploy(
    placeholder, await factory.getAddress(), placeholder, placeholder,
  );
  await router.waitForDeployment();
  const updates = await (await ethers.getContractFactory("VentureUpdates")).deploy(await factory.getAddress());
  await updates.waitForDeployment();

  const params = {
    name: "Openkernel", symbol: "KERN",
    metadataURI: JSON.stringify({
      pitch: "Memory-safety fuzzing lab for the mainline kernel.",
      sector: "research", description: "Continuous fuzzing for the Linux kernel's memory-safety surface.",
    }),
    pair: placeholder, buyTaxBps: 200, sellTaxBps: 300,
    devWallet: ethers.ZeroAddress, devBps: 4000, dividendBps: 3000, liquidityBps: 1500, mmBps: 1500,
    ethUsdPrice8: ETH_USD_8, targetRaiseWei: ethers.parseEther("5"), raiseDurationSecs: 7 * DAY,
    maxBuyWei: ethers.parseEther("5"), founderRaiseBps: 2000, founderSupplyBps: 1000,
    vestingSecs: 365 * DAY, mode: 0, minHoldForDividends: 0, dividendMode: 0, v3Path: "0x",
  };
  const salt = await mineSalt(tokenDeployer, [
    params.name, params.symbol, params.metadataURI, 10n ** 27n,
    creator.address, await factory.getAddress(), params.buyTaxBps, params.pair,
    BigInt(params.minHoldForDividends) * 10n ** 18n, params.dividendMode,
  ]);
  const creationFee = await factory.creationFeeWei();
  await (await factory.connect(creator).launch(params, salt, { value: creationFee })).wait();
  const coin = await factory.allTokens(0n);

  await (await factory.connect(buyer).buy(coin, { value: ethers.parseEther("0.6") })).wait();
  await (await factory.connect(admin).buy(coin, { value: ethers.parseEther("0.35") })).wait();

  console.log(JSON.stringify({
    factory: await factory.getAddress(),
    tokenDeployer: await tokenDeployer.getAddress(),
    hook: await hook.getAddress(),
    router: await router.getAddress(),
    updates: await updates.getAddress(),
    weth: placeholder,
    coin,
    buyer: buyer.address,
  }, null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
