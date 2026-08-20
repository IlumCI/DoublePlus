import { ethers } from "hardhat";
import { readFileSync } from "fs";
import { join } from "path";

/// Simulate a UI-equivalent launch right now: mine the vanity salt, then run
/// the exact transaction through eth_call and eth_estimateGas without
/// spending gas. This is precisely what a wallet does before sending.
async function main() {
  const dep = JSON.parse(readFileSync(join(__dirname, "../deployments/arc-v4-launchpad.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const factory = await ethers.getContractAt("QuiverFactory", dep.contracts.factory);

  const params = {
    name: "Sim",
    symbol: "SIM",
    metadataURI: "",
    stock: dep.v4.weth,
    taxBps: 100,
  };

  const Token = await ethers.getContractFactory("QuiverToken");
  const initCode = ethers.concat([
    Token.bytecode,
    ethers.AbiCoder.defaultAbiCoder().encode(
      ["string", "string", "string", "uint256", "address", "address", "uint16", "address"],
      [params.name, params.symbol, params.metadataURI, ethers.parseEther("1000000000"), signer.address, dep.contracts.factory, params.taxBps, params.stock],
    ),
  ]);
  const hash = ethers.keccak256(initCode);
  let salt = "";
  for (let i = 0n; i < 4_000_000n; i++) {
    const s = ethers.zeroPadValue(ethers.toBeHex(i), 32);
    const a = ethers.getCreate2Address(dep.contracts.factory, s, hash);
    if ((BigInt(a) & 0xffffn) === 0x4663n) { salt = s; break; }
  }
  if (!salt) throw new Error("no salt");
  console.log("salt mined");

  const data = factory.interface.encodeFunctionData("launch", [params, salt]);
  const tx = { from: signer.address, to: dep.contracts.factory, data };

  const res = await ethers.provider.call(tx);
  const [token] = factory.interface.decodeFunctionResult("launch", res);
  console.log("eth_call launch OK — would create token:", token);

  const gas = await ethers.provider.estimateGas(tx);
  const gasPrice = (await ethers.provider.getFeeData()).gasPrice!;
  console.log("estimateGas OK:", gas.toString(), "| cost ~", ethers.formatEther(gas * gasPrice), "USDC");
}
main().catch((e) => { console.error("FAILED:", e.message?.slice(0, 300)); process.exit(1); });
