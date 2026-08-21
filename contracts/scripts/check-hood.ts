import { ethers } from "hardhat";
async function main() {
  const F = "0x2A992C57AD63e4cC856C5Dc2F89f5Bc34eC00965";
  const H = "0x0A39aE6542aDdC1294c09a2B4Caa1eAb66dCC044";
  const R = "0x26490b524a8eaB733562d3F349c9ad4Ed6D7C4ac";
  const hook = await ethers.getContractAt("HoodHook", H);
  const fac = await ethers.getContractAt("HoodFactory", F);
  console.log("hook.factory   ==", await hook.factory(), "(expect factory)");
  console.log("hook.treasury  ==", await hook.treasury(), "(expect admin)");
  console.log("fac.protocolAdmin ==", await fac.protocolAdmin());
  console.log("fac.weth       ==", await fac.weth());
  console.log("fac.hook       ==", await fac.hook());
  console.log("fac.owner      ==", await fac.owner(), "(expect 0x0 renounced)");
  console.log("fac.totalTokens==", (await fac.totalTokens()).toString());
  console.log("router code    ==", (await ethers.provider.getCode(R)).length > 2 ? "deployed" : "MISSING");
  const rtr = await ethers.getContractAt("RhRouter", R);
  console.log("router.factory ==", await rtr.factory());
}
main().catch((e) => { console.error(e); process.exit(1); });
