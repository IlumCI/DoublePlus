// Bridge IN (Base -> Arc) via the arcx relayer. A user sends USDC on Base to
// the relayer address; this endpoint verifies that deposit on Base, then pays
// native USDC on Arc to the SAME address (never caller-chosen), minus a 1%
// fee, through ArcBridgePayout whose paid-mapping makes each Base tx pay out
// exactly once.
import {
  createPublicClient,
  createWalletClient,
  defineChain,
  http,
  parseAbi,
  type Address,
  type Hex,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

const RELAYER_DEPOSIT: Address = "0xe5b498a00596ab2fa0e8a86cdde15502b2552208";
const BASE_USDC: Address = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const FEE_BPS = 100n; // 1%
const MAX_USDC_RAW = BigInt(Number(process.env.BRIDGE_MAX_USDC ?? 500)) * 1_000_000n;
const BASE_MIN_CONF = 10n;

const ARC_RPC =
  process.env.RPC_UPSTREAM ??
  "https://arctorrpc-zwwbbvoo.b4a.run/?key=7629f78ccaf7e360ebefe49d6164ede3";

const arc = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [ARC_RPC] } },
});

const payoutAbi = parseAbi([
  "function paid(bytes32) view returns (bool)",
  "function payout(bytes32 baseTxHash, address to) payable",
]);

export default async function handler(req: any, res: any) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.RELAYER_PRIVATE_KEY;
  const payoutContract = process.env.ARC_BRIDGE_PAYOUT as Address | undefined;
  if (!key || !payoutContract) return res.status(503).json({ error: "bridge-in not configured yet" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const txHash = String(body.txHash ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: "txHash required" });

    // 1. Verify the user's USDC deposit to the relayer on Base.
    const basePub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org", { timeout: 20_000 }) });
    const receipt = await basePub.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
    if (!receipt || receipt.status !== "success") return res.status(400).json({ error: "Base transaction not found or failed" });
    const head = await basePub.getBlockNumber();
    if (head - receipt.blockNumber < BASE_MIN_CONF) {
      return res.status(425).json({ error: "Waiting for confirmations on Base; retry shortly" });
    }
    const transfer = receipt.logs.find(
      (l) =>
        l.address.toLowerCase() === BASE_USDC.toLowerCase() &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics[2] &&
        `0x${l.topics[2].slice(26)}`.toLowerCase() === RELAYER_DEPOSIT.toLowerCase(),
    );
    if (!transfer) return res.status(400).json({ error: "No USDC transfer to the bridge address in that transaction" });
    const sender = `0x${transfer.topics[1]!.slice(26)}` as Address;
    const amount6 = BigInt(transfer.data); // Base USDC is 6d
    if (amount6 === 0n) return res.status(400).json({ error: "Zero amount" });
    if (amount6 > MAX_USDC_RAW) return res.status(400).json({ error: `Amount exceeds the ${Number(MAX_USDC_RAW / 1_000_000n)} USDC per-transaction cap` });

    // 2. Pay out native USDC on Arc (18d) to the same address, minus the fee.
    const net6 = amount6 - (amount6 * FEE_BPS) / 10_000n;
    const valueWei = net6 * 10n ** 12n; // 6d -> 18d native

    const account = privateKeyToAccount(key as Hex);
    const arcPub = createPublicClient({ chain: arc, transport: http(ARC_RPC, { timeout: 25_000 }) });
    const already = (await arcPub.readContract({ address: payoutContract, abi: payoutAbi, functionName: "paid", args: [txHash as Hex] })) as boolean;
    if (already) return res.status(409).json({ error: "This deposit was already paid out" });

    const wallet = createWalletClient({ account, chain: arc, transport: http(ARC_RPC, { timeout: 25_000 }) });
    const { request } = await arcPub.simulateContract({
      account,
      address: payoutContract,
      abi: payoutAbi,
      functionName: "payout",
      args: [txHash as Hex, sender],
      value: valueWei,
    });
    const hash = await wallet.writeContract(request);
    const rc = await arcPub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return res.status(200).json({ hash, status: rc.status, to: sender, amountUsdc: Number(net6) / 1e6 });
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);
    return res.status(502).json({ error: msg });
  }
}
