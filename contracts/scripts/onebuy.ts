import { ethers } from "hardhat";
async function main() {
  const [, , alice] = await ethers.getSigners();
  const d = require("../deployments/localnet.json");
  const launchpad = await ethers.getContractAt("Launchpad", d.contracts.launchpad);
  await (await launchpad.connect(alice).buy(d.demoToken, 0, 4000000000n, { value: ethers.parseEther("0.005") })).wait();
  console.log("buy sent");
}
main();
