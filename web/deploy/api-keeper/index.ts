// Reward keeper for the copair launchpad (Robinhood Chain). Runs on a Vercel
// cron: for every launched coin it (1) harvests the hook once accrued trade
// fees are worth harvesting, which converts them to the pair token and pays
// 80% into the holder dividend tracker and 20% to the creator, and (2) pushes
// payouts with claimForMany so holders receive their pair tokens without
// pressing Claim. Both calls are permissionless; the keeper only spends gas.
import { createPublicClient, createWalletClient, defineChain, http, type Address, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const RPC = process.env.RH_RPC ?? "https://rpc.mainnet.chain.robinhood.com";
const FACTORY: Address = "0x44F0fEF21366e9a8FA7e594FAc0166eA63efd62c";
const HOOK: Address = "0xa775543d7CFd79de8Cf5305A60f11c990099C044";
const STATE_VIEW: Address = "0xf3334192d15450cdd385c8b70e03f9a6bd9e673b";
const WETH: Address = "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73";
const V3_FACTORY: Address = "0x1f7d7550B1b028f7571E69A784071F0205FD2EfA";
const POOL_MANAGER: Address = "0x8366a39cc670b4001a1121b8f6a443a643e40951";
const ROUTER: Address = "0x7414F382cc855b318ad47B889c7eEEC1764d552F";
const START_BLOCK = 34558420n;
const ZERO: Address = "0x0000000000000000000000000000000000000000";

const HARVEST_MIN_USD = Number(process.env.HARVEST_MIN_USD ?? 5);
const PAYOUT_MIN_USD = Number(process.env.PAYOUT_MIN_USD ?? 1);
const MIN_GAS_ETH = 0.0005;
// Buyback and burn of the official token, funded by ETH sent to the keeper.
const BURN_TOKEN: Address = (process.env.BURN_TOKEN as Address) ?? ZERO;
const DEAD: Address = "0x000000000000000000000000000000000000dEaD";
const BURN_GAS_RESERVE_ETH = Number(process.env.BURN_GAS_RESERVE_ETH ?? 0.002);
const BURN_MIN_ETH = Number(process.env.BURN_MIN_ETH ?? 0.0005);
const Q96 = 2n ** 96n;

const chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: [RPC] } },
});

const factoryAbi = [
  { type: "function", name: "totalTokens", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "allTokens", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "address" }] },
  {
    type: "function",
    name: "listings",
    stateMutability: "view",
    inputs: [{ type: "address" }],
    outputs: [
      { name: "creator", type: "address" },
      { name: "stock", type: "address" },
      { name: "taxBps", type: "uint16" },
      { name: "createdAt", type: "uint64" },
      { name: "poolId", type: "bytes32" },
    ],
  },
] as const;
const hookAbi = [
  { type: "function", name: "tokenFees", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "pairFees", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "harvest", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [] },
] as const;
const tokenAbi = [
  { type: "function", name: "pendingRewards", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "claimForMany", stateMutability: "nonpayable", inputs: [{ type: "address[]" }], outputs: [] },
  { type: "function", name: "claimFor", stateMutability: "nonpayable", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  {
    type: "event",
    name: "Transfer",
    inputs: [
      { name: "from", type: "address", indexed: true },
      { name: "to", type: "address", indexed: true },
      { name: "value", type: "uint256", indexed: false },
    ],
  },
] as const;
const stateViewAbi = [
  {
    type: "function",
    name: "getSlot0",
    stateMutability: "view",
    inputs: [{ name: "poolId", type: "bytes32" }],
    outputs: [
      { name: "sqrtPriceX96", type: "uint160" },
      { name: "tick", type: "int24" },
      { name: "protocolFee", type: "uint24" },
      { name: "lpFee", type: "uint24" },
    ],
  },
] as const;
const v3FactoryAbi = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [{ type: "address" }, { type: "address" }, { type: "uint24" }], outputs: [{ type: "address" }] },
] as const;
const v3PoolAbi = [
  {
    type: "function",
    name: "slot0",
    stateMutability: "view",
    inputs: [],
    outputs: [
      { type: "uint160" }, { type: "int24" }, { type: "uint16" }, { type: "uint16" }, { type: "uint16" }, { type: "uint8" }, { type: "bool" },
    ],
  },
] as const;

const pc = createPublicClient({ chain, transport: http(RPC, { batch: { wait: 16 } }) });

const usdCache = new Map<string, number>();
async function tokenUsd(addr: Address): Promise<number> {
  const key = addr.toLowerCase();
  const hit = usdCache.get(key);
  if (hit !== undefined) return hit;
  let usd = 0;
  try {
    const r = await fetch(`https://robinhoodchain.blockscout.com/api/v2/tokens/${addr}`, { headers: { accept: "application/json" } });
    if (r.ok) {
      const v = Number((await r.json())?.exchange_rate);
      if (Number.isFinite(v) && v > 0) usd = v;
    }
  } catch { /* fall through */ }
  if (usd === 0 && key !== WETH.toLowerCase()) {
    // Price through the token's V3 WETH pool (18-dec memes like PONS).
    try {
      const wethUsd = await tokenUsd(WETH);
      for (const fee of [10000, 3000, 500, 100]) {
        const pool = (await pc.readContract({ address: V3_FACTORY, abi: v3FactoryAbi, functionName: "getPool", args: [addr, WETH, fee] })) as Address;
        if (pool === ZERO) continue;
        const slot0 = await pc.readContract({ address: pool, abi: v3PoolAbi, functionName: "slot0" });
        const p = (Number(slot0[0]) / 2 ** 96) ** 2;
        if (p > 0 && wethUsd > 0) {
          const wethIs0 = WETH.toLowerCase() < key;
          usd = wethUsd * (wethIs0 ? 1 / p : p);
        }
        break;
      }
    } catch { /* keep 0 */ }
  }
  usdCache.set(key, usd);
  return usd;
}

export default async function handler(req: any, res: any) {
  const secret = process.env.CRON_SECRET ?? "";
  const auth = String(req.headers?.authorization ?? "");
  if (!secret || auth !== `Bearer ${secret}`) {
    res.status(401).json({ error: "unauthorized" });
    return;
  }
  const pk = process.env.KEEPER_PK as Hex | undefined;
  if (!pk) {
    res.status(200).json({ skipped: "no KEEPER_PK on this project" });
    return;
  }
  const account = privateKeyToAccount(pk.startsWith("0x") ? pk : (`0x${pk}` as Hex));
  const wallet = createWalletClient({ account, chain, transport: http(RPC) });

  const out: any = { keeper: account.address, harvests: [], payouts: [], errors: [] };
  try {
    const gas = Number(await pc.getBalance({ address: account.address })) / 1e18;
    out.gasEth = gas.toFixed(6);
    if (gas < MIN_GAS_ETH) {
      res.status(200).json({ ...out, skipped: "keeper out of gas, fund the address" });
      return;
    }

    const total = Number(await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "totalTokens" }));
    const latest = await pc.getBlockNumber();

    for (let i = 0; i < total; i++) {
      const coin = (await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "allTokens", args: [BigInt(i)] })) as Address;
      try {
        const [, pair, , , poolId] = (await pc.readContract({ address: FACTORY, abi: factoryAbi, functionName: "listings", args: [coin] })) as any;
        const pairUsd = await tokenUsd(pair);
        if (pairUsd <= 0) {
          out.errors.push({ coin, error: "pair unpriced, skipped" });
          continue;
        }

        // 1) Harvest when accrued fees are worth it. tokenFees is in coin
        // units; value it through the pool's pair-per-coin price.
        const [tFees, pFees] = await Promise.all([
          pc.readContract({ address: HOOK, abi: hookAbi, functionName: "tokenFees", args: [coin] }) as Promise<bigint>,
          pc.readContract({ address: HOOK, abi: hookAbi, functionName: "pairFees", args: [coin] }) as Promise<bigint>,
        ]);
        let coinUsd = 0;
        try {
          const [sqrtP] = (await pc.readContract({ address: STATE_VIEW, abi: stateViewAbi, functionName: "getSlot0", args: [poolId] })) as any;
          const tokenIs0 = coin.toLowerCase() < String(pair).toLowerCase();
          const p = (Number(sqrtP) / 2 ** 96) ** 2;
          if (p > 0) coinUsd = pairUsd * (tokenIs0 ? p : 1 / p);
        } catch { /* price unavailable; coin fees valued at 0 */ }
        const feesUsd = (Number(tFees) / 1e18) * coinUsd + (Number(pFees) / 1e18) * pairUsd;
        if (feesUsd >= HARVEST_MIN_USD) {
          const { request } = await pc.simulateContract({ account, address: HOOK, abi: hookAbi, functionName: "harvest", args: [coin] });
          const hash = await wallet.writeContract(request);
          await pc.waitForTransactionReceipt({ hash });
          out.harvests.push({ coin, feesUsd: feesUsd.toFixed(2), tx: hash });
        }

        // 2) Push payouts to holders owed enough to justify gas.
        const logs = await pc.getLogs({
          address: coin,
          event: tokenAbi[2] as any,
          fromBlock: START_BLOCK,
          toBlock: latest,
        });
        const holders = new Set<string>();
        for (const lg of logs as any[]) {
          for (const a of [lg.args.from, lg.args.to]) {
            const s = String(a).toLowerCase();
            if (
              s !== ZERO &&
              s !== coin.toLowerCase() &&
              ![FACTORY, HOOK, POOL_MANAGER, ROUTER].map((x) => x.toLowerCase()).includes(s)
            )
              holders.add(s);
          }
        }
        const list = [...holders] as Address[];
        const pendings = await Promise.all(
          list.map((h) => pc.readContract({ address: coin, abi: tokenAbi, functionName: "pendingRewards", args: [h] }).catch(() => 0n) as Promise<bigint>),
        );
        const due = list.filter((_, j) => (Number(pendings[j]) / 1e18) * pairUsd >= PAYOUT_MIN_USD);
        for (let j = 0; j < due.length; j += 100) {
          const chunk = due.slice(j, j + 100);
          const { request } = await pc.simulateContract({ account, address: coin, abi: tokenAbi, functionName: "claimForMany", args: [chunk] });
          const hash = await wallet.writeContract(request);
          await pc.waitForTransactionReceipt({ hash });
          out.payouts.push({ coin, holders: chunk.length, tx: hash });
        }
        // claimForMany swallows individual failures (try/catch inside the
        // token), so re-check and deliver stragglers one by one.
        if (due.length) {
          const still = await Promise.all(
            due.map((h) => pc.readContract({ address: coin, abi: tokenAbi, functionName: "pendingRewards", args: [h] }).catch(() => 0n) as Promise<bigint>),
          );
          for (let j = 0; j < due.length && j < 120; j++) {
            if ((Number(still[j]) / 1e18) * pairUsd < PAYOUT_MIN_USD) continue;
            try {
              const { request } = await pc.simulateContract({ account, address: coin, abi: tokenAbi, functionName: "claimFor", args: [due[j]] });
              const hash = await wallet.writeContract(request);
              await pc.waitForTransactionReceipt({ hash });
              out.payouts.push({ coin, holder: due[j], retried: true, tx: hash });
            } catch (err: any) {
              out.errors.push({ coin, holder: due[j], error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 120) });
            }
          }
        }
      } catch (err: any) {
        out.errors.push({ coin, error: String(err?.shortMessage ?? err?.message ?? err).slice(0, 200) });
      }
    }

    // Weekly flywheel: once the previous epoch has closed, fire the
    // permissionless top-3 buyback-and-burn + open trader claims.
    try {
      const GENESIS = 1786540685;
      const EPOCH = 604800;
      const nowS = Math.floor(Date.now() / 1000);
      const prev = Math.floor((nowS - GENESIS) / EPOCH) - 1;
      if (prev >= 0) {
        const epochAbi = [
          { type: "function", name: "epochResolved", stateMutability: "view", inputs: [{ type: "uint256" }], outputs: [{ type: "bool" }] },
          { type: "function", name: "resolveEpoch", stateMutability: "nonpayable", inputs: [{ type: "uint256" }], outputs: [] },
        ] as const;
        const done = (await pc.readContract({ address: HOOK, abi: epochAbi, functionName: "epochResolved", args: [BigInt(prev)] })) as boolean;
        if (!done) {
          const sim = await pc.simulateContract({ account, address: HOOK, abi: epochAbi, functionName: "resolveEpoch", args: [BigInt(prev)] });
          const tx = await wallet.writeContract(sim.request);
          await pc.waitForTransactionReceipt({ hash: tx });
          out.epochResolved = { epoch: prev, tx };
        }
      }
    } catch (err: any) {
      out.errors.push({ epoch: String(err?.shortMessage ?? err?.message ?? err).slice(0, 200) });
    }

    // Buyback and burn: any ETH parked in the keeper wallet beyond the gas
    // reserve is the burn budget (the treasury tops it up manually). Buy the
    // official token through the router and send it to the dead address.
    try {
      if (BURN_TOKEN !== ZERO) {
        const bal = await pc.getBalance({ address: account.address });
        const reserve = BigInt(Math.round(BURN_GAS_RESERVE_ETH * 1e18));
        const budget = bal > reserve ? bal - reserve : 0n;
        if (budget >= BigInt(Math.round(BURN_MIN_ETH * 1e18))) {
          const buyAbi = [
            { type: "function", name: "buy", stateMutability: "payable", inputs: [{ type: "address" }, { type: "bytes" }, { type: "uint256" }], outputs: [{ type: "uint256" }] },
          ] as const;
          const sim = await pc.simulateContract({ account, address: ROUTER, abi: buyAbi, functionName: "buy", args: [BURN_TOKEN, "0x", 0n], value: budget });
          const buyTx = await wallet.writeContract(sim.request);
          await pc.waitForTransactionReceipt({ hash: buyTx });
          const erc20 = [
            { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
            { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
          ] as const;
          const got = (await pc.readContract({ address: BURN_TOKEN, abi: erc20, functionName: "balanceOf", args: [account.address] })) as bigint;
          if (got > 0n) {
            const t = await pc.simulateContract({ account, address: BURN_TOKEN, abi: erc20, functionName: "transfer", args: [DEAD, got] });
            const burnTx = await wallet.writeContract(t.request);
            await pc.waitForTransactionReceipt({ hash: burnTx });
            out.buyback = { ethIn: (Number(budget) / 1e18).toFixed(6), burned: (Number(got) / 1e18).toFixed(2), buyTx, burnTx };
          }
        }
      }
    } catch (err: any) {
      out.errors.push({ buyback: String(err?.shortMessage ?? err?.message ?? err).slice(0, 200) });
    }

    res.status(200).json(out);
  } catch (err: any) {
    res.status(500).json({ ...out, fatal: String(err?.shortMessage ?? err?.message ?? err).slice(0, 300) });
  }
}
