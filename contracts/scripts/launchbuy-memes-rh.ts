import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

// Meme pairs the user asked for (deep WETH pools, fee 10000).
const MEMES = [
  { name: "Pons Print", symbol: "PPRINT", pair: "0x39dBED3a2bd333467115dE45665cC57F813C4571", fee: 10000 }, // PONS
  { name: "Cash Cat Print", symbol: "CCPRINT", pair: "0x020bfC650A365f8BB26819deAAbF3E21291018b4", fee: 10000 }, // CASHCAT
];

async function fetchUsd8(address: string): Promise<bigint> {
  try {
    const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${address}`, { headers: { accept: "application/json" } });
    const j: any = await r.json();
    const v = Number(j?.exchange_rate);
    if (Number.isFinite(v) && v > 0) return BigInt(Math.round(v * 1e8));
  } catch {}
  return 1n * 10n ** 8n;
}

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-fork.json"), "utf8"));
  const factory = await ethers.getContractAt("RhFactory", dep.contracts.factory as string);
  const router = await ethers.getContractAt("RhRouter", dep.contracts.router as string);
  const hook = await ethers.getContractAt("RhHook", dep.contracts.hook as string);
  const factoryAddr = dep.contracts.factory as string;
  const Token = await ethers.getContractFactory("QuiverToken");

  for (const m of MEMES) {
    const pairUsd8 = await fetchUsd8(m.pair);
    const params = { name: m.name, symbol: m.symbol, metadataURI: "", pair: m.pair, taxBps: 300, pairUsdPrice8: pairUsd8 };
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
    console.log(`launched ${m.symbol}: ${coin}  pair=${m.pair}  pairUsd8=${pairUsd8}`);

    // Buy it with 0.0002 ETH via the router: ETH -> WETH -> pair -> coin.
    const path = ethers.solidityPacked(["address", "uint24", "address"], [WETH, m.fee, m.pair]);
    const erc = await ethers.getContractAt("QuiverToken", coin);
    const before = await erc.balanceOf(signer.address);
    await (await router.buy(coin, path, 0, { value: ethers.parseEther("0.0002") })).wait();
    const got = (await erc.balanceOf(signer.address)) - before;
    console.log(`  bought ${ethers.formatEther(got)} ${m.symbol}  (tokenFees=${await hook.tokenFees(coin)})`);
  }
  console.log("\nbalance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
