import { ethers } from "hardhat";
async function main() {
  const fac = await ethers.getContractAt("HoodFactory", "0x2A992C57AD63e4cC856C5Dc2F89f5Bc34eC00965");
  const n = await fac.totalTokens();
  console.log("total:", n.toString());
  for (let i = 0n; i < n; i++) {
    const a = await fac.allTokens(i);
    const l = await fac.listings(a);
    const t = await ethers.getContractAt("QuiverToken", a);
    console.log(i.toString(), a, await t.symbol(), "creator:", l.creator, "at:", new Date(Number(l.createdAt) * 1000).toISOString());
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
