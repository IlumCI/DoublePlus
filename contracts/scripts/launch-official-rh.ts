import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

// Launch the official token (first launch on the buyback factory) and set it as
// the buyback target. Overridable via env.
const NAME = process.env.OFF_NAME ?? "stockprintr";
const SYMBOL = process.env.OFF_SYMBOL ?? "PRINT";
const PAIR = process.env.OFF_PAIR ?? "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // NVDA
const USD8 = BigInt(process.env.OFF_USD8 ?? "20024000000"); // ~$200.24

async function main() {
  const [signer] = await ethers.getSigners();
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/robinhood-rh-buyback.json"), "utf8"));
  const factoryAddr = dep.contracts.factory as string;
  const factory = await ethers.getContractAt("RhBuybackFactory", factoryAddr);
  const hook = await ethers.getContractAt("RhBuybackHook", dep.contracts.hook as string);
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
  const official = await factory.allTokens((await factory.totalTokens()) - 1n);
  console.log(`official ${SYMBOL}: ${official}  pair=${PAIR}  usd8=${USD8}`);

  await (await hook.setMainToken(official)).wait();
  console.log("hook.setMainToken ->", await hook.mainToken());
  console.log("balance after:", ethers.formatEther(await ethers.provider.getBalance(signer.address)), "ETH");
}

main().catch((e) => { console.error(e); process.exit(1); });
