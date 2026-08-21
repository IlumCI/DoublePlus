import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Relaunch the meme test coins with correct explicit pair prices so the $3,000
// start cap is sized right (the earlier launch fell back to $1).
const MEMES = [
  { name: "Pons Print", symbol: "PPRINT2", pair: "0x39dBED3a2bd333467115dE45665cC57F813C4571", usd8: 2667825n }, // PONS $0.02667825
  { name: "Cash Cat Print", symbol: "CCPRINT2", pair: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", usd8: 4079951n }, // CASHCAT $0.04079951
];

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-fork.json"), "utf8"));
  const factory = await ethers.getContractAt("RhFactory", dep.contracts.factory as string);
  const factoryAddr = dep.contracts.factory as string;
  const Token = await ethers.getContractFactory("QuiverToken");

  for (const m of MEMES) {
    const params = { name: m.name, symbol: m.symbol, metadataURI: "", pair: m.pair, taxBps: 300, pairUsdPrice8: m.usd8 };
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, factoryAddr, params.taxBps, params.pair],
    );
    const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    let salt = "";
    for (let i = 0n; i < 4_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      if ((BigInt(ethers.getCreate2Address(factoryAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
    }
    await (await factory.launch(params, salt)).wait();
    const total = await factory.totalTokens();
    const coin = await factory.allTokens(total - 1n);
    console.log(`${m.symbol}: ${coin}  pairUsd8=${m.usd8}`);
  }
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
