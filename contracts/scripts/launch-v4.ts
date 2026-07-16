import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/quiver-v4.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("QuiverFactory", dep.contracts.factory);
  const factoryAddr = await factory.getAddress();

  const stock = process.env.STOCK ?? "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"; // NVDA
  const params = {
    name: process.env.NAME ?? "Quiver Genesis",
    symbol: process.env.SYMBOL ?? "QVR",
    metadataURI: process.env.META ?? "",
    stock,
    taxBps: Number(process.env.TAX ?? 300),
  };

  // Mine the CREATE2 salt so the token address ends in 4663.
  const Token = await ethers.getContractFactory("QuiverToken");
  const args = ethers.AbiCoder.defaultAbiCoder().encode(
    ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
    [params.name, params.symbol, params.metadataURI, 10n ** 27n, signer.address, factoryAddr, params.taxBps, params.stock],
  );
  const initCodeHash = ethers.keccak256(ethers.concat([Token.bytecode, args]));
  let salt = "";
  for (let i = 0n; i < 2_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(factoryAddr, s, initCodeHash);
    if ((BigInt(a) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no salt");

  console.log("launching", params.symbol, "reward", stock, "tax", params.taxBps);
  const tx = await factory.launch(params, salt);
  const rcpt = await tx.wait();
  const count = await factory.totalTokens();
  const token = await factory.allTokens(count - 1n);
  console.log("\n✅ launched", token, "(ends", token.slice(-4) + ")", "tx", rcpt?.hash);
}

main().catch((e) => { console.error(e); process.exit(1); });
