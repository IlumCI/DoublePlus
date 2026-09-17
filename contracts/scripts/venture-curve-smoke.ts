import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Live smoke of the curve sell side and the curve fees against a deployed
// stack. Deliberately does not graduate: it exercises the paths the unit
// tests cover, on a real chain, for the price of a few hundred thousand gas.
//
//   DEPLOYMENTS  deployments file (default venture-testnet.json)
//   BUY_ETH      size of the test buy (default 0.0008)

const DAY = 86_400n;
const ETH_USD_8 = 1_865_000n * 10n ** 8n; // scaled so a tiny target clears base cost

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
  const treasury: string = dep.treasury;
  const buyWei = ethers.parseEther(process.env.BUY_ETH ?? "0.0008");

  const buyBps = await factory.curveBuyFeeBps();
  const sellBps = await factory.curveSellFeeBps();
  console.log(`signer ${signer.address}  buyFee ${buyBps}bps  sellFee ${sellBps}bps`);

  const params = {
    name: "Curve Smoke", symbol: "CSMOKE",
    metadataURI: JSON.stringify({ pitch: "Live check of the curve sell side.", sector: "research" }),
    pair: dep.contracts.weth, buyTaxBps: 200, sellTaxBps: 300,
    devWallet: ethers.ZeroAddress, devBps: 4000, dividendBps: 3000, liquidityBps: 1500, mmBps: 1500,
    ethUsdPrice8: ETH_USD_8, targetRaiseWei: ethers.parseEther("0.011"), raiseDurationSecs: DAY,
    maxBuyWei: ethers.parseEther("0.011"), founderRaiseBps: 2000, founderSupplyBps: 1000,
    vestingSecs: 90n * DAY, mode: 0, minHoldForDividends: 0, dividendMode: 0, v3Path: "0x",
  };
  const salt = await mineSalt(tokenDeployer, [
    params.name, params.symbol, params.metadataURI, 10n ** 27n,
    signer.address, dep.contracts.factory, params.buyTaxBps, params.pair,
    BigInt(params.minHoldForDividends) * 10n ** 18n, params.dividendMode,
  ]);
  await (await factory.launch(params, salt)).wait();
  const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log("launched", coin);

  // --- buy: the entry fee is taken before the curve is quoted ---------------
  const feesBefore = await factory.feesAccrued(treasury);
  await (await factory.buy(coin, { value: buyWei })).wait();
  const spent = await factory.spentWei(coin, signer.address);
  const feeTaken = (await factory.feesAccrued(treasury)) - feesBefore;
  const expectFee = (buyWei * BigInt(buyBps)) / 10_000n;
  console.log(`buy ${ethers.formatEther(buyWei)} -> escrow ${ethers.formatEther(spent)}  fee ${ethers.formatEther(feeTaken)}`);
  if (feeTaken !== expectFee) throw new Error(`entry fee ${feeTaken} != ${expectFee}`);
  if (spent > buyWei - expectFee) throw new Error("spentWei exceeds net value: escrow would be short");
  const raised = (await factory.curveState(coin)).raisedWei;
  if (raised !== spent) throw new Error(`raisedWei ${raised} != sum(spentWei) ${spent}`);

  // --- sell half back: capped at cost basis, fee out of the proceeds --------
  const erc = await ethers.getContractAt("QuiverToken", coin);
  const held = await erc.balanceOf(signer.address);
  const half = held / 2n / 10n ** 18n;
  await (await erc.approve(dep.contracts.factory, held)).wait();
  const ethBefore = await ethers.provider.getBalance(signer.address);
  const rc = await (await factory.sell(coin, half, 0)).wait();
  const got = (await ethers.provider.getBalance(signer.address)) - ethBefore + rc!.gasUsed * rc!.gasPrice;
  const basisQ = (spent * (half * 10n ** 18n)) / held;
  const expectOut = basisQ - (basisQ * BigInt(sellBps)) / 10_000n;
  console.log(`sell ${half} whole -> ${ethers.formatEther(got)} ETH (cap ${ethers.formatEther(basisQ)})`);
  if (got !== expectOut) throw new Error(`sell payout ${got} != ${expectOut}`);

  const claims = await factory.spentWei(coin, signer.address);
  const raisedAfter = (await factory.curveState(coin)).raisedWei;
  if (raisedAfter !== claims) throw new Error(`escrow ${raisedAfter} != claims ${claims} after sell`);
  console.log(`solvent: escrow ${ethers.formatEther(raisedAfter)} == claims ${ethers.formatEther(claims)}`);

  // --- open mode takes the protocol threshold and has no deadline ----------
  const gradWei = await factory.graduationRaiseWei();
  const openParams = { ...params, name: "Open Smoke", symbol: "OSMOKE", founderRaiseBps: 0, mode: 1 };
  const openSalt = await mineSalt(tokenDeployer, [
    openParams.name, openParams.symbol, openParams.metadataURI, 10n ** 27n,
    signer.address, dep.contracts.factory, openParams.buyTaxBps, openParams.pair,
    BigInt(openParams.minHoldForDividends) * 10n ** 18n, openParams.dividendMode,
  ]);
  await (await factory.launch(openParams, openSalt)).wait();
  const openCoin = await factory.allTokens((await factory.totalTokens()) - 1n);
  const st = await factory.curveState(openCoin);
  if (st.targetRaiseWei !== gradWei) throw new Error(`open target ${st.targetRaiseWei} != ${gradWei}`);
  if (st.deadline !== 2n ** 64n - 1n) throw new Error(`open deadline not uncapped: ${st.deadline}`);
  console.log(`open curve ${openCoin} target ${ethers.formatEther(gradWei)} ETH, no deadline`);

  console.log(`treasury accrued: ${ethers.formatEther(await factory.feesAccrued(treasury))} ETH`);
  console.log("CURVE SMOKE OK");
}
main().catch((e) => { console.error(e); process.exit(1); });
