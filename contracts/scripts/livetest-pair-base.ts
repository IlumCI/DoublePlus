import { ethers } from "hardhat";

// Live proof of pair-denominated trading with REAL B-20 tokens: get USDC, launch
// a USDC-paired coin, buy it with USDC and sell it back — all through our own
// v4 pool + StockTradeRouter. No external stock DEX involved.
const FACTORY = "0xEA3dC62EbB16CAEB848c316a89D54a90Fc348301";
const TRADE_ROUTER = "0xB4a19DCe37F55256AE6eeaF4432a64df8A06E9Bb";
const SLIP = "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const WETH = "0x4200000000000000000000000000000000000006";

const wethAbi = ["function deposit() payable", "function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"];
const usdcAbi = ["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)", "function decimals() view returns (uint8)"];
const slipAbi = ["function exactInputSingle((address tokenIn,address tokenOut,int24 tickSpacing,address recipient,uint256 deadline,uint256 amountIn,uint256 amountOutMinimum,uint160 sqrtPriceLimitX96)) payable returns (uint256)"];
const factoryAbi = [
  "function launch((string name,string symbol,string metadataURI,address pair,uint16 taxBps,uint256 pairUsdPrice8,uint16 burnBps,uint16 liquidityBps) p, bytes32 salt) payable returns (address token, bytes32 poolId)",
];
const routerAbi = ["function buy(address,uint256,uint256) returns (uint256)", "function sell(address,uint256,uint256) returns (uint256)"];
const coinAbi = ["function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function symbol() view returns (string)"];

async function main() {
  const [me] = await ethers.getSigners();
  const now = async () => (await ethers.provider.getBlock("latest"))!.timestamp + 600;
  console.log("trader:", me.address, "ETH:", ethers.formatEther(await ethers.provider.getBalance(me.address)));

  // 1. Get USDC: wrap 0.004 ETH -> WETH -> USDC (Slipstream ts=1).
  const weth = await ethers.getContractAt(wethAbi, WETH);
  const usdc = await ethers.getContractAt(usdcAbi, USDC);
  const slip = await ethers.getContractAt(slipAbi, SLIP);
  await (await weth.deposit({ value: ethers.parseEther("0.004") })).wait();
  await (await weth.approve(SLIP, ethers.MaxUint256)).wait();
  await (await slip.exactInputSingle({ tokenIn: WETH, tokenOut: USDC, tickSpacing: 1, recipient: me.address, deadline: await now(), amountIn: ethers.parseEther("0.004"), amountOutMinimum: 0, sqrtPriceLimitX96: 0 })).wait();
  const usdcBal = await usdc.balanceOf(me.address);
  console.log("got USDC:", ethers.formatUnits(usdcBal, 6));

  // 2. Launch a USDC-paired test coin ($1 USDC price, 8dp).
  const factory = await ethers.getContractAt(factoryAbi, FACTORY);
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const meta = JSON.stringify({ description: "stonkpad live trade test — USDC pair", pair: "USDC" });
  const tx = await factory.launch({ name: "StonkTest", symbol: "STONKT", metadataURI: meta, pair: USDC, taxBps: 100, pairUsdPrice8: 100000000n, burnBps: 0, liquidityBps: 0 }, salt);
  const rc = await tx.wait();
  // Find the launched token from the Launched event (topic1 = token).
  const launched = rc!.logs.find((l: any) => l.topics.length >= 2 && l.address.toLowerCase() === FACTORY.toLowerCase());
  const coin = "0x" + (launched!.topics[1] as string).slice(26);
  console.log("launched coin:", coin);
  const erc = await ethers.getContractAt(coinAbi, coin);

  // 3. Buy the coin with 3 USDC via StockTradeRouter.
  const router = await ethers.getContractAt(routerAbi, TRADE_ROUTER);
  await (await usdc.approve(TRADE_ROUTER, ethers.MaxUint256)).wait();
  const spend = 3_000000n; // 3 USDC
  await (await router.buy(coin, spend, 0)).wait();
  const bought = await erc.balanceOf(me.address);
  console.log("BUY 3 USDC ->", ethers.formatEther(bought), "STONKT");
  if (bought === 0n) throw new Error("buy returned 0");

  // 4. Sell it back for USDC.
  await (await erc.approve(TRADE_ROUTER, ethers.MaxUint256)).wait();
  const usdcBefore = await usdc.balanceOf(me.address);
  await (await router.sell(coin, bought, 0)).wait();
  const back = (await usdc.balanceOf(me.address)) - usdcBefore;
  console.log("SELL ->", ethers.formatUnits(back, 6), "USDC back");
  console.log("\n✅ Real B-20 pair-denominated trading works: buy + sell through our own pool.");
  console.log("demo coin on the board:", coin);
}
main().catch((e) => { console.error(e); process.exit(1); });
