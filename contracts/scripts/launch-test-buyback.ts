import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Launch a plain test coin on the buyback factory (no setMainToken).
const NAME = process.env.T_NAME ?? "Test Cat";
const SYMBOL = process.env.T_SYMBOL ?? "TCAT";
const PAIR = process.env.T_PAIR ?? "0x020bfC650A365f8BB26819deAAbF3E21291018b4"; // CASHCAT
const USD8 = BigInt(process.env.T_USD8 ?? "4080000"); // ~$0.0408

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-buyback.json"), "utf8"));
  const factoryAddr = dep.contracts.factory as string;
  const factory = await ethers.getContractAt("RhBuybackFactory", factoryAddr);
  const Token = await ethers.getContractFactory("QuiverToken");

  const params = { name: NAME, symbol: SYMBOL, metadataURI: "", pair: PAIR, taxBps: 300, pairUsdPrice8: USD8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [NAME, SYMBOL, "", 10n ** 27n, signer.address, factoryAddr, 300, PAIR],
  );
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 4_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    if ((BigInt(ethers.getCreate2Address(factoryAddr, s, hash)) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no vanity salt");
  await (await factory.launch(params, salt)).wait();
  const coin = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log(`${SYMBOL}: ${coin}  pair=${PAIR}  usd8=${USD8}`);
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
