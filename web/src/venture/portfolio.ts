import { parseAbiItem, type Address } from "viem";

import { boughtEvent, ercAbi, factoryAbi, loadVentures, routedEvent, VENTURE, venturePc, vestingAbi, type Venture } from "./client";
import { curveValue, marketValue, position, type Flows, type Position } from "./pnl";

/**
 * Everything the portfolio needs about one wallet, read in one pass: balances,
 * curve ledgers, the wallet's own trade logs for P&L, and anything it can
 * collect. The P&L arithmetic lives in pnl.ts, where it is tested.
 */

const soldEvent = parseAbiItem(
  "event CurveSell(address indexed token, address indexed seller, uint256 ethOut, uint256 tokensIn, uint128 priceWei, uint256 feeWei)",
);
const poolTickAbi = [
  { type: "function", name: "poolTick", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "int24" }] },
] as const;

export interface Holding {
  v: Venture;
  balance: bigint;
  /** ETH drip waiting in the token contract. */
  pending: bigint;
  /** Curve ledger: net ETH still booked against this wallet, and tokens bought. */
  spent: bigint;
  bought: bigint;
  vestingClaimable: bigint;
  /** ETH this wallet gets back from a failed raise, 0 when none. */
  refundable: bigint;
  pos: Position;
}

export interface Portfolio {
  rows: Holding[];
  /** ETH credited inside the factory: founder cuts, curve-fee shares. */
  factoryOwed: bigint;
}

const ZERO = "0x0000000000000000000000000000000000000000";

type Flow = Flows;
const emptyFlows = (): Flow => ({ curveIn: 0n, curveOut: 0n, routerIn: 0n, routerOut: 0n });

/** The wallet's ETH legs, per coin, from its own curve and router logs.
 *  `token` narrows the read to one coin (the coin page). */
async function loadFlows(me: Address, token?: Address): Promise<Map<string, Flow>> {
  const head = await venturePc.getBlockNumber();
  const range = { fromBlock: VENTURE.startBlock, toBlock: head };
  const [cBuys, cSells, routed] = await Promise.all([
    venturePc.getLogs({ address: VENTURE.factory, event: boughtEvent, args: { buyer: me, ...(token ? { token } : {}) }, ...range }).catch(() => []),
    venturePc.getLogs({ address: VENTURE.factory, event: soldEvent, args: { seller: me, ...(token ? { token } : {}) }, ...range }).catch(() => []),
    venturePc.getLogs({ address: VENTURE.router, event: routedEvent, args: { trader: me, ...(token ? { coin: token } : {}) }, ...range }).catch(() => []),
  ]);
  const flows = new Map<string, Flow>();
  const f = (t: string) => {
    const k = t.toLowerCase();
    let x = flows.get(k);
    if (!x) flows.set(k, (x = emptyFlows()));
    return x;
  };
  for (const l of cBuys) f(l.args.token!).curveIn += l.args.ethIn ?? 0n;
  for (const l of cSells) f(l.args.token!).curveOut += l.args.ethOut ?? 0n;
  for (const l of routed) {
    const x = f(l.args.coin!);
    if (l.args.isBuy) x.routerIn += l.args.ethIn ?? 0n;
    else x.routerOut += l.args.ethOut ?? 0n;
  }
  return flows;
}

/** One coin's holding for this wallet; null when the wallet has no stake. */
async function holding(me: Address, v: Venture, fl: Flow | undefined, sellFeeBps: number): Promise<Holding | null> {
  const isCreator = v.creator.toLowerCase() === me.toLowerCase();
  const [balance, pending, spent, bought] = await Promise.all([
    venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "balanceOf", args: [me] }).catch(() => 0n) as Promise<bigint>,
    venturePc.readContract({ address: v.address, abi: ercAbi, functionName: "pendingRewards", args: [me] }).catch(() => 0n) as Promise<bigint>,
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "spentWei", args: [v.address, me] }).catch(() => 0n) as Promise<bigint>,
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "boughtTokens", args: [v.address, me] }).catch(() => 0n) as Promise<bigint>,
  ]);
  if (balance === 0n && pending === 0n && spent === 0n && !isCreator && !fl) return null;

  let vestingClaimable = 0n;
  if (isCreator && v.vesting !== ZERO) {
    vestingClaimable = (await venturePc.readContract({ address: v.vesting, abi: vestingAbi, functionName: "claimable" }).catch(() => 0n)) as bigint;
  }

  // A failed raise pays back the booked spend, as long as the wallet still
  // holds every token it bought (refund() takes them all back).
  const refundable = v.phase === "failed" && !v.swept && spent > 0n && balance >= bought ? spent : 0n;

  let value: bigint | null = null;
  let basis: Position["basis"] = "none";
  if (v.phase === "failed") {
    value = refundable; basis = "refund";
  } else if (v.phase === "graduated") {
    if (v.pair.toLowerCase() === VENTURE.weth.toLowerCase()) {
      const tick = await venturePc.readContract({ address: VENTURE.hook, abi: poolTickAbi, functionName: "poolTick", args: [v.address] }).catch(() => null);
      if (tick !== null) {
        const coinIsC0 = BigInt(v.address) < BigInt(v.pair);
        value = marketValue(balance, Number(tick), coinIsC0, v.policy.sellTaxBps + VENTURE.platformFeeBps);
        basis = "market";
      }
    }
  } else {
    // Raising: the curve buys back only what this wallet bought on it.
    value = curveValue(v, bought < balance ? bought : balance, spent, sellFeeBps);
    basis = "curve";
  }
  return { v, balance, pending, spent, bought, vestingClaimable, refundable, pos: position(fl ?? emptyFlows(), value, basis) };
}

export async function loadHolding(me: Address, v: Venture, sellFeeBps: number): Promise<Holding | null> {
  const flows = await loadFlows(me, v.address);
  return holding(me, v, flows.get(v.address.toLowerCase()), sellFeeBps);
}

export async function loadPortfolio(me: Address, sellFeeBps: number): Promise<Portfolio> {
  const [ventures, flows, factoryOwed] = await Promise.all([
    loadVentures(),
    loadFlows(me),
    venturePc.readContract({ address: VENTURE.factory, abi: factoryAbi, functionName: "feesAccrued", args: [me] }).catch(() => 0n) as Promise<bigint>,
  ]);
  const rows = await Promise.all(ventures.map((v) => holding(me, v, flows.get(v.address.toLowerCase()), sellFeeBps)));
  return { rows: rows.filter((r): r is Holding => r !== null), factoryOwed };
}
