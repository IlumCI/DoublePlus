import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";
const NAME = process.env.T_NAME ?? "Robin Cat";
const SYMBOL = process.env.T_SYMBOL ?? "RCAT";
const PAIR = process.env.T_PAIR ?? "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // NVDA
const USD8 = BigInt(process.env.T_USD8 ?? "20031000000");
async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-final.json"), "utf8"));
  const factoryAddr = dep.contracts.factory as string;
  const factory = await ethers.getContractAt("RhFinalFactory", factoryAddr);
  const Token = await ethers.getContractFactory("QuiverToken");
  const params = { name: NAME, symbol: SYMBOL, metadataURI: "", pair: PAIR, taxBps: 300, pairUsdPrice8: USD8 };
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string","string","string","uint256","address","address","uint16","address"],
    [NAME, SYMBOL, "", 10n**27n, signer.address, factoryAddr, 300, PAIR]);
  const hash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i=0n;i<4_000_000n;i++){const s=ethers.zeroPadValue(ethers.toBeHex(i),32);if((BigInt(ethers.getCreate2Address(factoryAddr,s,hash))&0xffffn)===0x4663n){salt=s;break;}}
  await (await factory.launch(params, salt)).wait();
  const coin = await factory.allTokens((await factory.totalTokens())-1n);
  console.log(`${SYMBOL}: ${coin}  pair=${PAIR}`);
}
main().catch(e=>{console.error(e);process.exit(1);});
