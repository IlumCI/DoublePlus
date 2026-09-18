import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Drives one raise all the way to a graduated Uniswap V4 pool against a live
// deployment, then trades in that pool so the token page has a real chart,
// real stat strip and real trade tape to render. Everything the unit and fork
// suites assert, done once on a real chain end to end.
//
//   DEPLOYMENTS  deployments file (default venture-testnet.json)
//   TARGET_ETH   raise target (default 0.005, the testnet graduation trigger)

const DAY = 86_400n;
const ETH_USD_8 = 1_865_000n * 10n ** 8n; // scaled so a tiny target clears base cost
const eth = (v: bigint) => ethers.formatEther(v);

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
  const file = process.env.DEPLOYMENTS ?? "venture-testnet.json";
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments", file), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("VentureFactory", dep.contracts.factory);
  const tokenDeployer = await ethers.getContractAt("VentureTokenDeployer", dep.contracts.tokenDeployer);
  const target = ethers.parseEther(process.env.TARGET_ETH ?? "0.005");

  const creationFee = await factory.creationFeeWei();
  const buyBps = await factory.curveBuyFeeBps();
  console.log("balance:", eth(await ethers.provider.getBalance(signer.address)), "ETH");
  console.log("target: ", eth(target), "ETH   creationFee:", eth(creationFee), "ETH");

  const run = Date.now().toString(36).slice(-4).toUpperCase();
  const params = {
    name: `Helios Grid ${run}`, symbol: `HGX${run}`,
    metadataURI: JSON.stringify({
      pitch: "Perovskite tandem cells for rooftop retrofit.",
      description: "Helios Grid is building tandem perovskite-silicon panels that retrofit onto existing rooftop mounts, targeting 28% module efficiency at residential scale.",
      sector: "research",
      website: "https://example.org/helios",
      twitter: "https://x.com/example",
      telegram: "https://t.me/example",
      github: "https://github.com/example/helios",
    }),
    pair: dep.contracts.weth, buyTaxBps: 200, sellTaxBps: 300,
    devWallet: ethers.ZeroAddress, devBps: 4000, dividendBps: 3000, liquidityBps: 1500, mmBps: 1500,
    ethUsdPrice8: ETH_USD_8, targetRaiseWei: target, raiseDurationSecs: DAY,
    maxBuyWei: target, founderRaiseBps: 1000, founderSupplyBps: 1000,
    vestingSecs: 90n * DAY, mode: 0, minHoldForDividends: 10_000, dividendMode: 1, v3Path: "0x",
  };
  const salt = await mineSalt(tokenDeployer, [
    params.name, params.symbol, params.metadataURI, 10n ** 27n,
    signer.address, dep.contracts.factory, params.buyTaxBps, params.pair,
    BigInt(params.minHoldForDividends) * 10n ** 18n, params.dividendMode,
  ]);
  await (await factory.launch(params, salt, { value: creationFee })).wait();
  const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log("launched:", coin, params.symbol);

  // --- fill the curve in a few buys, so the curve has a real fill history ---
  // The entry fee comes off the top, so gross up to land escrow on target.
  const gross = (target * 10_000n) / (10_000n - BigInt(buyBps)) + 10n;
  const slices = [gross / 3n, gross / 3n, gross - 2n * (gross / 3n)];
  for (const [i, slice] of slices.entries()) {
    await (await factory.buy(coin, { value: slice })).wait();
    const s = await factory.curveState(coin);
    console.log(`  buy ${i + 1}: sent ${eth(slice)} -> raised ${eth(s.raisedWei)} / ${eth(s.targetRaiseWei)}`);
  }

  const pre = await factory.curveState(coin);
  if (pre.raisedWei < pre.targetRaiseWei) throw new Error(`under target: ${eth(pre.raisedWei)}`);

  // --- graduate --------------------------------------------------------------
  const rec = await (await factory.finalize(coin)).wait();
  const poolId = (await factory.listings(coin)).poolId;
  console.log("GRADUATED. poolId:", poolId, `(gas ${rec!.gasUsed})`);

  const tokenPos = await factory.tokenPositions(coin);
  const pairPos = await factory.pairPositions(coin);
  console.log("locked token position:", tokenPos.liquidity.toString(), `ticks [${tokenPos.tickLower}, ${tokenPos.tickUpper}]`);
  console.log("locked pair position: ", pairPos.liquidity.toString(), `ticks [${pairPos.tickLower}, ${pairPos.tickUpper}]`);
  console.log("\nnext: trade the pool with venture-pool-trade.ts");
  console.log("TOKEN=", coin);
}
main().catch((e) => { console.error(e); process.exit(1); });
