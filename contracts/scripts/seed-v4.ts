import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// A small, varied set of demo markets, each rewarding a different stock, so the
// launchpad has real content to browse. Launch is gas-only (supply is seeded
// single-sided), so this stays cheap.
const STOCKS = {
  NVDA: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC",
  AAPL: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9",
  TSLA: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d",
  GOOGL: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3",
  AMZN: "0x12f190a9F9d7D37a250758b26824B97CE941bF54",
  AMD: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC",
};

const TOKENS = [
  { name: "Diamond Hands", symbol: "DIAM", stock: STOCKS.TSLA, tax: 500, desc: "For holders who never fold. Every trade drips tokenized Tesla to the paper-proof." },
  { name: "Green Candle", symbol: "GREEN", stock: STOCKS.AAPL, tax: 300, desc: "A market that pays you Apple stock just for holding through the wicks." },
  { name: "Moonshot", symbol: "MOON", stock: STOCKS.AMZN, tax: 200, desc: "Low tax, high conviction. Holders accrue tokenized Amazon on every swap." },
  { name: "Ape Reserve", symbol: "APE", stock: STOCKS.AMD, tax: 400, desc: "Ape in, earn AMD. The reserve rewards its holders with real semiconductor exposure." },
  { name: "Blue Chip", symbol: "CHIP", stock: STOCKS.GOOGL, tax: 300, desc: "Degeneracy with a dividend — this one streams tokenized Alphabet to holders." },
];

async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/quiver-v4.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("QuiverFactory", dep.contracts.factory);
  const factoryAddr = await factory.getAddress();
  const Token = await ethers.getContractFactory("QuiverToken");

  for (const t of TOKENS) {
    const meta = JSON.stringify({ description: t.desc });
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      [t.name, t.symbol, meta, 10n ** 27n, signer.address, factoryAddr, t.tax, t.stock],
    );
    const initCodeHash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    let salt = "";
    for (let i = 0n; i < 4_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(factoryAddr, s, initCodeHash);
      if ((BigInt(a) & 0xffffn) === 0x4663n) { salt = s; break; }
    }
    if (!salt) throw new Error("no salt for " + t.symbol);
    const tx = await factory.launch({ name: t.name, symbol: t.symbol, metadataURI: meta, stock: t.stock, taxBps: t.tax }, salt);
    const rcpt = await tx.wait();
    const count = await factory.totalTokens();
    const token = await factory.allTokens(count - 1n);
    console.log(`✅ ${t.symbol.padEnd(6)} ${token} (ends ${token.slice(-4)}) tax ${t.tax / 100}% reward ${t.stock.slice(0, 8)} tx ${rcpt?.hash}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
