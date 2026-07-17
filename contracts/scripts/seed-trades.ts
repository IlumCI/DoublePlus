import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Put a little real volume through a few pools so Trending / Recently-active
// have something to rank. Small buys via the native-ETH router.
async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/quiver-v4.json"), "utf8"));
  const router = await ethers.getContractAt(
    ["function buy(address token, uint256 minOut) payable returns (uint256)"],
    dep.contracts.router,
  );
  const factory = await ethers.getContractAt("QuiverFactory", dep.contracts.factory);
  const count = Number(await factory.totalTokens());
  const tokens: string[] = [];
  for (let i = 0; i < count; i++) tokens.push(await factory.allTokens(i));

  // Buy amounts (ETH) — vary so volume ranks differently.
  const plan: [number, string][] = [
    [0.0009, tokens[tokens.length - 1]],
    [0.0006, tokens[tokens.length - 2]],
    [0.0004, tokens[tokens.length - 3]],
    [0.0009, tokens[0]],
    [0.0003, tokens[tokens.length - 4]],
  ];

  for (const [eth, token] of plan) {
    if (!token) continue;
    try {
      const tx = await router.buy(token, 0n, { value: ethers.parseEther(String(eth)) });
      const r = await tx.wait();
      console.log(`✅ bought ${eth} ETH of ${token.slice(0, 10)}… tx ${r?.hash}`);
    } catch (e: any) {
      console.log(`✗ buy ${token.slice(0, 10)} failed: ${e.shortMessage ?? e.message}`);
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
