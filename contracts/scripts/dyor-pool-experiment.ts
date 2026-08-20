/**
 * BasedBot visibility experiment: mirror the LIVE token onto DyorSwap's V3
 * factory (the pool source BasedBot indexes on Arc) with a small single-sided
 * position at the same price as the V4 pool, then report what to watch for.
 *
 * Run: npx hardhat run scripts/dyor-pool-experiment.ts --network robinhood
 * (network slot is env-driven; point ROBINHOOD_RPC_URL at Arc)
 */
import { ethers } from "hardhat";

const DYOR_FACTORY = "0xF0DB7b58379503491d857DB50aC9eCE64C653918".toLowerCase();
const USDC = "0x3600000000000000000000000000000000000000";
const LIVE = "0xa9F66aEB11d0303AA14c6A27fBa02E624BE14663";
const QUIVER_ROUTER = "0x6dE8C12324Cd13E40E813B390F8Eea38DBA299b0";
const FEE = 10_000; // 1% tier, tickSpacing 200 (same as LOULOUTE's pool)
const TICK_SPACING = 200n;
const MIN_TICK = -887_200; // min usable tick aligned to spacing 200

const Q96 = 2n ** 96n;

function sqrtBig(v: bigint): bigint {
  if (v < 2n) return v;
  let x = v, y = (x + 1n) / 2n;
  while (y < x) { x = y; y = (x + v / x) / 2n; }
  return x;
}

async function main() {
  const [deployer] = await ethers.getSigners();
  const bal = await ethers.provider.getBalance(deployer.address);
  console.log("deployer", deployer.address, ethers.formatEther(bal), "USDC");

  const factory = new ethers.Contract(ethers.getAddress(DYOR_FACTORY), [
    "function getPool(address,address,uint24) view returns (address)",
  ], deployer);

  // ------------------------------------------------------------------
  // 1. Get LIVE tokens: buy ~0.5 USDC from our V4 pool via QuiverRouter.
  // ------------------------------------------------------------------
  const live = new ethers.Contract(LIVE, [
    "function balanceOf(address) view returns (uint256)",
    "function transfer(address,uint256) returns (bool)",
  ], deployer);
  let liveBal: bigint = await live.balanceOf(deployer.address);
  console.log("LIVE balance before:", ethers.formatEther(liveBal));
  if (liveBal < ethers.parseEther("50000")) {
    const router = new ethers.Contract(QUIVER_ROUTER, [
      "function buy(address token, uint256 minOut) payable returns (uint256)",
    ], deployer);
    const tx = await router.buy(LIVE, 0, { value: ethers.parseEther("0.5") });
    await tx.wait();
    liveBal = await live.balanceOf(deployer.address);
    console.log("bought; LIVE balance:", ethers.formatEther(liveBal));
  }

  // ------------------------------------------------------------------
  // 2. Price: match the V4 pool's current price (USDC has 6 decimals on
  //    Dyor pools, LIVE has 18). token0 = USDC (0x3600... sorts first).
  //    rawPrice(token1 per token0) = live_raw_per_usdc_raw.
  // ------------------------------------------------------------------
  const stateView = new ethers.Contract("0xf3334192d15450cdd385c8b70e03f9a6bd9e673b", [
    "function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24, uint24)",
  ], deployer);
  const quiverFactory = new ethers.Contract("0x3004664a07bDA6CbD416C9486Dc1212eE81fA1fC", [
    "function listings(address) view returns (address creator, address stock, uint16 taxBps, uint64 createdAt, bytes32 poolId)",
  ], deployer);
  const listing = await quiverFactory.listings(LIVE);
  const [v4SqrtP] = await stateView.getSlot0(listing.poolId);
  // V4 pool: WUSDC (18d) vs LIVE (18d); LIVE is currency1 (0xa9... > 0xD7? no:
  // 0xa9F6 < 0xD79a so LIVE is currency0). price(c1/c0) = wusdc per live.
  const wusdcPerLiveX192 = (v4SqrtP as bigint) * (v4SqrtP as bigint); // *2^192
  const usdcPerLive = Number(wusdcPerLiveX192 / Q96) / Number(Q96); // ~3e-6
  console.log("V4 price:", usdcPerLive, "USDC per LIVE");

  // Dyor raw price token1/token0 = LIVE_raw per USDC_raw
  // 1 raw USDC = 1e-6 USDC buys (1e-6 / usdcPerLive) LIVE = *1e18 raw.
  const liveRawPerUsdcRaw = (1e-6 / usdcPerLive) * 1e18; // ~3.3e17
  const sqrtPriceX96 = sqrtBig(BigInt(Math.round(liveRawPerUsdcRaw)) * Q96 * Q96) ;
  // tick = log_1.0001(price)
  const tick = Math.floor(Math.log(liveRawPerUsdcRaw) / Math.log(1.0001));
  const tickUpper = Number((BigInt(tick) / TICK_SPACING) * TICK_SPACING); // aligned below current
  console.log("target sqrtPriceX96:", sqrtPriceX96.toString(), "tick ~", tick, "tickUpper", tickUpper);

  // ------------------------------------------------------------------
  // 3. Deploy the seeder, fund it with LIVE, seed single-sided (token1-only
  //    below current tick so USDC buys have liquidity to eat into).
  // ------------------------------------------------------------------
  const Seeder = await ethers.getContractFactory("PoolSeeder");
  const seeder = await Seeder.deploy(deployer.address);
  await seeder.waitForDeployment();
  const seederAddr = await seeder.getAddress();
  console.log("PoolSeeder:", seederAddr);

  const seedAmount = (liveBal * 95n) / 100n;
  await (await live.transfer(seederAddr, seedAmount)).wait();

  // liquidity L for token1-only range [MIN_TICK, tickUpper]:
  // amount1 = L * (sqrt(Pu) - sqrt(Pl)) / 2^96  ->  L = amount1 * 2^96 / diff
  const sqrtAtTick = (t: number): bigint => {
    // 1.0001^(t/2) * 2^96 via float is fine for seeding accuracy
    return BigInt(Math.round(Math.pow(1.0001, t / 2) * 2 ** 96));
  };
  const sqrtPu = sqrtAtTick(tickUpper);
  const sqrtPl = sqrtAtTick(MIN_TICK);
  const liquidity = (seedAmount * Q96) / (sqrtPu - sqrtPl);
  console.log("seeding", ethers.formatEther(seedAmount), "LIVE, liquidity", liquidity.toString());

  const tx2 = await seeder.seed(
    ethers.getAddress(DYOR_FACTORY), USDC, LIVE, FEE, sqrtPriceX96, MIN_TICK, tickUpper, liquidity,
    { gasLimit: 9_000_000 },
  );
  const rc = await tx2.wait();
  console.log("seed tx:", rc?.hash);

  const pool = await factory.getPool(USDC, LIVE, FEE);
  console.log("Dyor pool:", pool);
  const poolC = new ethers.Contract(pool, [
    "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
    "function liquidity() view returns (uint128)",
    "function token0() view returns (address)",
  ], deployer);
  console.log("slot0:", (await poolC.slot0()).sqrtPriceX96.toString(), "tick", (await poolC.slot0()).tick.toString());
  console.log("in-range liquidity:", (await poolC.liquidity()).toString());
  console.log("token0:", await poolC.token0());
  console.log("\nDONE - watch BasedBot for LIVE /", pool);
}

main().catch((e) => { console.error(e); process.exit(1); });
