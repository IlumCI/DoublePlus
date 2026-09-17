import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// End-to-end smoke of a deployed venture stack, single funded key:
// launch -> curve buy -> (small target) graduate -> router round-trip ->
// harvest -> vesting state. Sized for a testnet wallet holding ~0.05 ETH.
//
//   SMOKE_TARGET_ETH  raise target (default 0.011). The curve's base cost is
//                     the $3k start FDV over the curve supply, priced via
//                     ETH_USD_8 — the target must clear it.
//   ETH_USD_8         ETH/USD price with 8 decimals. Defaults to a scaled
//                     1_865_000e8 so the base cost is ~0.001 ETH and a faucet
//                     wallet can graduate a curve; pass the real price on
//                     mainnet.
//   DEPLOYMENTS       deployments file (default venture-testnet.json)

const DAY = 86_400n;

async function main() {
  const file = process.env.DEPLOYMENTS ?? "venture-testnet.json";
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments", file), "utf8"));
  const [signer] = await ethers.getSigners();
  console.log("smoke on", file, "signer:", signer.address);

  const factory = await ethers.getContractAt("VentureFactory", dep.contracts.factory);
  const router = await ethers.getContractAt("VentureRouter", dep.contracts.router);
  const hook = await ethers.getContractAt("VentureFeeHook", dep.contracts.hook);
  const weth = dep.contracts.weth;

  const ethUsd8 = BigInt(process.env.ETH_USD_8 ?? 1_865_000n * 10n ** 8n);
  const target = ethers.parseEther(process.env.SMOKE_TARGET_ETH ?? "0.011");

  // 1) Launch with a tiny target so one wallet can graduate it.
  const params = {
    name: "Venture Smoke",
    symbol: "SMOKE",
    metadataURI: JSON.stringify({ description: "venture smoke test", pitch: "throwaway" }),
    pair: weth,
    buyTaxBps: 200,
    sellTaxBps: 400,
    devWallet: "0x0000000000000000000000000000000000000000",
    devBps: 2500,
    dividendBps: 2500,
    liquidityBps: 2500,
    mmBps: 2500,
    ethUsdPrice8: ethUsd8,
    targetRaiseWei: target,
    raiseDurationSecs: DAY,
    maxBuyWei: target,
    founderRaiseBps: 3000,
    founderSupplyBps: 1000,
    vestingSecs: 90n * DAY,
    mode: 0,
    minHoldForDividends: 0,
    dividendMode: 0,
    v3Path: "0x",
  };
  const Token = await ethers.getContractFactory("QuiverToken");
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address", "uint256", "uint8"],
    [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, dep.contracts.factory, params.buyTaxBps, weth],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 8_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(dep.contracts.tokenDeployer, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity salt");
  await (await factory.launch(params, salt)).wait();
  const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log("launched:", coin);

  // 2) Fill the curve to target in one buy (self-backed).
  await (await factory.buy(coin, { value: target + target / 10n })).wait();
  const st = await factory.curveState(coin);
  console.log("curve:", { sold: st.soldWhole.toString(), raised: ethers.formatEther(st.raisedWei) });

  // 3) Graduate.
  await (await factory.finalize(coin)).wait();
  const listing = await factory.listings(coin);
  console.log("graduated, poolId:", listing.poolId);

  // 4) Router round-trip.
  await (await router.buy(coin, "0x", 0, { value: target / 20n })).wait();
  const erc = await ethers.getContractAt("QuiverToken", coin);
  const held = await erc.balanceOf(signer.address);
  await (await erc.approve(dep.contracts.router, ethers.MaxUint256)).wait();
  await (await router.sell(coin, held / 4n, "0x", 0)).wait();
  console.log("router round-trip ok");

  // 4b) Referral leg: bind a fresh scout, trade, confirm the scout got paid
  // their cut of the protocol fee in the same transaction.
  const scout = ethers.Wallet.createRandom();
  const bound = await hook.referrerOf(signer.address);
  if (bound === ethers.ZeroAddress) {
    await (await hook.setReferrer(scout.address)).wait();
  }
  const scoutBefore = await erc.balanceOf(scout.address);
  await (await router.buy(coin, "0x", 0, { value: target / 20n })).wait();
  const scoutGot = (await erc.balanceOf(scout.address)) - scoutBefore;
  console.log("referral: scout", scout.address, "earned", scoutGot.toString(), "coin from one referred buy");
  if (scoutGot <= 0n) throw new Error("referral payout missing");

  // 5) Fees settle inline on every trade — read the results.
  const [policy] = await hook.policyOf(coin);
  console.log("fee policy:", {
    buyTaxBps: policy.buyTaxBps.toString(), sellTaxBps: policy.sellTaxBps.toString(),
    devBps: policy.devBps.toString(), dividendBps: policy.dividendBps.toString(),
    liquidityBps: policy.liquidityBps.toString(), mmBps: policy.mmBps.toString(),
  });
  console.log("holder dividends distributed inline:", (await erc.totalRewardsDistributed()).toString());
  const vestingAddr = await factory.vestingOf(coin);
  const vesting = await ethers.getContractAt("FounderVesting", vestingAddr);
  console.log("vesting:", vestingAddr, "started:", (await vesting.startTime()).toString(),
    "allocation:", ethers.formatEther(await vesting.totalAllocation()));
  console.log("SMOKE PASSED");
}
main().catch((e) => { console.error(e); process.exit(1); });
