/* Launch the official UHOOD coin on the Flywheel factory (chain 4663).
 * Usage: ROBINHOOD_RPC_URL=... npx tsx scripts/launch-uhood.ts
 * Reads the deployer key from .env.deployer; dev buy sized to leave gas. */
import { ethers } from "ethers";
import * as fs from "fs";

const FACTORY = "0x44F0fEF21366e9a8FA7e594FAc0166eA63efd62c";
const WETH = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";

const factoryAbi = [
  "function launch((string name,string symbol,string metadataURI,address pair,uint16 taxBps,uint256 pairUsdPrice8) p, bytes32 salt) payable returns (address token)",
  "event Launched(address indexed token, address indexed creator, address indexed pair, uint16 taxBps, bytes32 poolId)",
];

async function wethUsd8(): Promise<bigint> {
  try {
    const r = await fetch(
      `https://blockscout.mainnet.chain.robinhood.com/api/v2/tokens/${WETH}`,
    );
    const j: any = await r.json();
    const usd = Number(j?.exchange_rate ?? 0);
    if (usd > 100) return BigInt(Math.round(usd * 1e8));
  } catch {}
  return 1855n * 10n ** 8n; // snapshot fallback
}

async function main() {
  const env = fs.readFileSync(".env.deployer", "utf8");
  const m = env.match(/PRIVATE_KEY=(0x)?([0-9a-fA-F]{64})/)!;
  const provider = new ethers.JsonRpcProvider(process.env.ROBINHOOD_RPC_URL);
  const wallet = new ethers.Wallet((m[1] ?? "0x") + m[2], provider);
  const factory = new ethers.Contract(FACTORY, factoryAbi, wallet);

  const metadata = JSON.stringify({
    description:
      "The official coin of the uhood launchpad on Robinhood Chain. Every trade on the platform feeds the weekly flywheel: buybacks and burns for the top coins, ETH rewards for traders, all on chain.",
    logo: "https://www.uhood.fun/uhood-pfp.png",
    website: "https://www.uhood.fun",
    twitter: "https://x.com/tobinhoodapp",
  });

  const price8 = await wethUsd8();
  const salt = ethers.hexlify(ethers.randomBytes(32));
  const params = {
    name: "uhood",
    symbol: "UHOOD",
    metadataURI: metadata,
    pair: WETH,
    taxBps: 100,
    pairUsdPrice8: price8,
  };

  const bal = await provider.getBalance(wallet.address);
  console.log("deployer:", wallet.address, "balance:", ethers.formatEther(bal));
  console.log("WETH usd8:", price8.toString());

  // Size the dev buy from what is left after a generous gas reserve.
  let value = 0n;
  try {
    const est = await factory.launch.estimateGas(params, salt, { value: 0 });
    const fee = (await provider.getFeeData()).gasPrice ?? 0n;
    const gasCost = est * 2n * (fee > 0n ? fee : 1n);
    const spare = bal - gasCost * 2n;
    if (spare > ethers.parseEther("0.0001")) value = spare / 2n;
    console.log("gas est:", est.toString(), "gasPrice:", fee.toString(), "devBuy:", ethers.formatEther(value));
  } catch (e: any) {
    console.log("estimate failed:", e?.shortMessage ?? e?.message);
  }

  const tx = await factory.launch(params, salt, { value });
  console.log("tx:", tx.hash);
  const rc = await tx.wait();
  const ev = rc!.logs
    .map((l: any) => { try { return factory.interface.parseLog(l); } catch { return null; } })
    .find((p: any) => p?.name === "Launched");
  console.log("token:", ev?.args?.token);
  console.log("poolId:", ev?.args?.poolId);
  console.log("block:", rc!.blockNumber);
}

main().catch((e) => { console.error(e); process.exit(1); });
