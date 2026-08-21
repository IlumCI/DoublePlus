import { ethers } from "hardhat";

async function main() {
  const [signer] = await ethers.getSigners();
  const to = process.env.TO!;
  const bal = await ethers.provider.getBalance(signer.address);
  // Orbit chains charge an L1 data fee on top of gas*price; keep a healthy
  // reserve so the transfer itself can always pay for inclusion.
  const reserve = ethers.parseEther(process.env.RESERVE ?? "0.0001");
  if (bal <= reserve) { console.log("nothing to sweep"); return; }
  const tx = await signer.sendTransaction({ to, value: bal - reserve });
  await tx.wait();
  console.log("swept", ethers.formatEther(bal - reserve), "ETH ->", to);
}
main().catch((e) => { console.error(e); process.exit(1); });
