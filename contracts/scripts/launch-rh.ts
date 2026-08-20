import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Two test launches: one paired against a stock (NVDA), one against a
// non-stock onchain token (VIRTUAL), proving both "ways" of the fork.
const TESTS = [
  { name: "Robin Doge", symbol: "RDOGE", pair: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", kind: "stock" }, // NVDA
  { name: "Meme Print", symbol: "MPRINT", pair: "0xc6911796042b15d7Fa4F6CDe69e245DdCd3d9c31", kind: "meme" }, // VIRTUAL
];

async function fetchUsd8(address: string): Promise<bigint> {
  try {
    const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${address}`, {
      headers: { accept: "application/json" },
    });
    const j: any = await r.json();
    const v = Number(j?.exchange_rate);
    if (Number.isFinite(v) && v > 0) return BigInt(Math.round(v * 1e8));
  } catch {}
  return 1n * 10n ** 8n; // $1 fallback
}

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-fork.json"), "utf8"));
  const factoryAddr = dep.contracts.factory as string;
  const factory = await ethers.getContractAt("RhFactory", factoryAddr);
  const Token = await ethers.getContractFactory("QuiverToken");

  for (const t of TESTS) {
    const pairUsd8 = await fetchUsd8(t.pair);
    const params = {
      name: t.name,
      symbol: t.symbol,
      metadataURI: "",
      pair: t.pair,
      taxBps: 300,
      pairUsdPrice8: pairUsd8,
    };
    // Mine a CREATE2 salt so the token address ends in 0x4663.
    const args = ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, factoryAddr, params.taxBps, params.pair],
    );
    const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
    let salt = "";
    for (let i = 0n; i < 4_000_000n; i++) {
      const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
      const a = ethers.getCreate2Address(factoryAddr, s, hash);
      if ((BigInt(a) & 0xffffn) === 0x4663n) { salt = s; break; }
    }
    if (!salt) throw new Error("no vanity salt for " + t.symbol);

    const tx = await factory.launch(params, salt);
    const rc = await tx.wait();
    // Read the freshly launched token address from allTokens.
    const total = await factory.totalTokens();
    const token = await factory.allTokens(total - 1n);
    console.log(`${t.kind.padEnd(6)} ${t.symbol}: ${token}  pair=${t.pair}  pairUsd8=${pairUsd8}  (tx ${rc?.hash})`);
  }
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
