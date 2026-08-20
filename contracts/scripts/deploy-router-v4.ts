import { ethers } from "hardhat";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

const POOL_MANAGER = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

async function main() {
  const [signer] = await ethers.getSigners();
  const depPath = join(__dirname, "../deployments/quiver-v4.json");
  const dep = JSON.parse(readFileSync(depPath, "utf8"));
  const hook = dep.contracts.hook;

  console.log("deployer:", signer.address, "| hook:", hook);
  const Router = await ethers.getContractFactory("QuiverRouter");
  const router = await Router.deploy(POOL_MANAGER, WETH, hook);
  await router.waitForDeployment();
  const addr = await router.getAddress();
  console.log("QuiverRouter:", addr);

  dep.contracts.router = addr;
  writeFileSync(depPath, JSON.stringify(dep, null, 2));
  console.log("saved to", depPath);
  console.log("verify: npx hardhat verify --network robinhood", addr, POOL_MANAGER, WETH, hook);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
