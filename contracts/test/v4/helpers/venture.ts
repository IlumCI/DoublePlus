import { expect } from "chai";
import { ethers } from "hardhat";

// Shared fixtures for the venture suites. Kept in one place so the stress
// runs exercise exactly the stack the unit tests do — a second, drifting copy
// of deployStack would quietly test a different contract.

export const ETH_USD_8 = 1865n * 10n ** 8n;
export const TARGET = ethers.parseEther("2");
export const DAY = 86_400;

export async function deployStack(minTargetWei: bigint = 1n) {
  const [admin] = await ethers.getSigners();
  const weth = await (await ethers.getContractFactory("WETH9")).deploy();
  await weth.waitForDeployment();

  // poolManager/v3Router are inert during the curve phase; any code-bearing
  // address that is never called works for these tests. The hook is real so
  // launch() can read its MAX_SIDE_TAX_BPS guardrail (its flags are only
  // checked by the PoolManager, which the curve phase never touches).
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
    admin.address,
    admin.address,
    placeholder, // poolManager (unused pre-finalize)
    await hook.getAddress(),
    await weth.getAddress(),
    placeholder, // v3Router (unused when pair is WETH)
    await vestingDeployer.getAddress(),
    await tokenDeployer.getAddress(),
     50, 100,
    minTargetWei,
  );
  await factory.waitForDeployment();
  expect(await factory.getAddress()).to.equal(predictedFactory);
  return { factory, tokenDeployer, weth };
}

export async function mineSalt(tokenDeployer: any, args: any[]) {
  const Token = await ethers.getContractFactory("QuiverToken");
  const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address", "uint256", "uint8"],
    args,
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, encoded]));
  const depAddr = await tokenDeployer.getAddress();
  for (let i = 0n; i < 6_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(depAddr, s, hash)) & 0xffffn) === 0x4663n) return s;
  }
  throw new Error("no vanity salt");
}

export async function launch(
  factory: any,
  tokenDeployer: any,
  creator: any,
  weth: string,
  overrides: Partial<Record<string, any>> = {},
  value: bigint = 0n,
) {
  const params = {
    name: "Venture",
    symbol: "VNT",
    metadataURI: "",
    pair: weth,
    buyTaxBps: 300,
    sellTaxBps: 300,
    devWallet: "0x0000000000000000000000000000000000000000",
    devBps: 2500,
    dividendBps: 2500,
    liquidityBps: 2500,
    mmBps: 2500,
    ethUsdPrice8: ETH_USD_8,
    targetRaiseWei: TARGET,
    raiseDurationSecs: 2 * DAY,
    maxBuyWei: TARGET, // no cap unless the test sets one
    founderRaiseBps: 3000,
    founderSupplyBps: 1000,
    vestingSecs: 180 * DAY,
    mode: 0,
    minHoldForDividends: 0,
    dividendMode: 0,
    v3Path: "0x",
    ...overrides,
  };
  const salt = await mineSalt(tokenDeployer, [
    params.name,
    params.symbol,
    params.metadataURI,
    10n ** 27n,
    creator.address,
    await factory.getAddress(),
    params.buyTaxBps,
    params.pair,
    BigInt(params.minHoldForDividends) * 10n ** 18n, // the deployer scales it
    params.dividendMode,
  ]);
  await (await factory.connect(creator).launch(params, salt, { value })).wait();
  return factory.allTokens((await factory.totalTokens()) - 1n);
}
