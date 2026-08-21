// Bridge OUT (Arc -> Base) via the arcx relayer. A user sends native USDC on
// Arc to the relayer address; this endpoint verifies that deposit on Arc, then
// pays ERC-20 USDC on Base to the SAME address (never caller-chosen), minus a
// 1% fee, through BaseBridgePayout whose paid-mapping makes each Arc tx pay out
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
const FEE_BPS = 100n; // 1%
const MAX_USDC_RAW = BigInt(Number(process.env.BRIDGE_MAX_USDC ?? 500)) * 1_000_000n;
const ARC_MIN_CONF = 3n;

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
  "function payout(bytes32 arcTxHash, address to, uint256 amount)",
]);

export default async function handler(req: any, res: any) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  res.setHeader("access-control-allow-methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });

  const key = process.env.RELAYER_PRIVATE_KEY;
  const payoutContract = process.env.BASE_BRIDGE_PAYOUT as Address | undefined;
  if (!key || !payoutContract) return res.status(503).json({ error: "bridge-out not configured yet" });

  try {
    const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body ?? {};
    const txHash = String(body.txHash ?? "");
    if (!/^0x[0-9a-fA-F]{64}$/.test(txHash)) return res.status(400).json({ error: "txHash required" });

    // 1. Verify the user's native USDC deposit to the relayer on Arc.
    const arcPub = createPublicClient({ chain: arc, transport: http(ARC_RPC, { timeout: 25_000 }) });
    const tx = await arcPub.getTransaction({ hash: txHash as Hex }).catch(() => null);
    if (!tx) return res.status(400).json({ error: "Arc transaction not found" });
    const receipt = await arcPub.getTransactionReceipt({ hash: txHash as Hex }).catch(() => null);
    if (!receipt || receipt.status !== "success") return res.status(400).json({ error: "Arc transaction failed or pending" });
    if ((tx.to ?? "").toLowerCase() !== RELAYER_DEPOSIT.toLowerCase()) {
      return res.status(400).json({ error: "Transaction is not a deposit to the bridge address" });
    }
    if (tx.value === 0n) return res.status(400).json({ error: "No native USDC sent" });
    const head = await arcPub.getBlockNumber();
    if (head - receipt.blockNumber < ARC_MIN_CONF) {
      return res.status(425).json({ error: "Waiting for confirmations on Arc; retry shortly" });
    }

    const sender = tx.from as Address;
    // Native USDC on Arc is 18d; the ERC-20 USDC on Base is 6d.
    const amount6 = tx.value / 10n ** 12n;
    if (amount6 === 0n) return res.status(400).json({ error: "Amount too small" });
    if (amount6 > MAX_USDC_RAW) return res.status(400).json({ error: `Amount exceeds the ${Number(MAX_USDC_RAW / 1_000_000n)} USDC per-transaction cap` });
    const net = amount6 - (amount6 * FEE_BPS) / 10_000n;

    // 2. Pay out on Base to the same address.
    const account = privateKeyToAccount(key as Hex);
    const basePub = createPublicClient({ chain: base, transport: http("https://mainnet.base.org", { timeout: 20_000 }) });
    const already = (await basePub.readContract({ address: payoutContract, abi: payoutAbi, functionName: "paid", args: [txHash as Hex] })) as boolean;
    if (already) return res.status(409).json({ error: "This deposit was already paid out" });

    const wallet = createWalletClient({ account, chain: base, transport: http("https://mainnet.base.org", { timeout: 20_000 }) });
    const { request } = await basePub.simulateContract({
      account,
      address: payoutContract,
      abi: payoutAbi,
      functionName: "payout",
      args: [txHash as Hex, sender, net],
    });
    const hash = await wallet.writeContract(request);
    const rc = await basePub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    return res.status(200).json({ hash, status: rc.status, to: sender, amountUsdc: Number(net) / 1e6 });
  } catch (e: any) {
    const msg = String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);
    return res.status(502).json({ error: msg });
  }
}
