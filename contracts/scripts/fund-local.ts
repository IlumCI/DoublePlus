import { ethers } from "hardhat";
async function main() {
  const [admin] = await ethers.getSigners();
  const to = process.env.FUND_TO!;
  await (await admin.sendTransaction({ to, value: ethers.parseEther("5") })).wait();
  console.log("funded", to, "balance:", ethers.formatEther(await ethers.provider.getBalance(to)));
}
main();
