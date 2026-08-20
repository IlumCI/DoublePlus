import { ethers } from "hardhat";
const TOKEN = "0xbe5fcc1b19de2d32777803b6ae13868bba04d57e";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const STATE_VIEW = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const HOOK = "0x0A39aE6542aDdC1294c09a2B4Caa1eAb66dCC044";
async function main() {
  const fac = await ethers.getContractAt("HoodFactory", "0x2A992C57AD63e4cC856C5Dc2F89f5Bc34eC00965");
  const l = await fac.listings(TOKEN);
  console.log("listing creator:", l.creator, "pair:", l.pair, "createdAt:", l.createdAt.toString());
  const t = await ethers.getContractAt("QuiverToken", TOKEN);
  console.log("name:", await t.name(), "symbol:", await t.symbol());
  const tokenIs0 = TOKEN.toLowerCase() < WETH.toLowerCase();
  const key = {
    currency0: tokenIs0 ? TOKEN : WETH,
    currency1: tokenIs0 ? WETH : TOKEN,
    fee: 0, tickSpacing: 60, hooks: HOOK,
  };
  const abi = ethers.AbiCoder.defaultAbiCoder();
  const poolId = ethers.keccak256(abi.encode(
    ["address","address","uint24","int24","address"],
    [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  console.log("tokenIs0:", tokenIs0, "poolId:", poolId);
  const sv = new ethers.Contract(STATE_VIEW, ["function getSlot0(bytes32) view returns (uint160 sqrtPriceX96, int24 tick, uint24 protocolFee, uint24 lpFee)"], ethers.provider);
  const s = await sv.getSlot0(poolId);
  console.log("sqrtPriceX96:", s[0].toString(), "tick:", s[1].toString());
  const p = (Number(s[0]) / 2 ** 96) ** 2;
  const wethPerToken = tokenIs0 ? p : 1 / p;
  console.log("WETH per token:", wethPerToken, "mcap USD @1855:", wethPerToken * 1e9 * 1855);
  const bal = await t.balanceOf(l.creator);
  console.log("creator balance:", ethers.formatEther(bal));
}
main().catch((e) => { console.error(e); process.exit(1); });
