import { parseAbiItem, zeroAddress, type Address, type Hex } from "viem";

import { loadVenture, SYSTEMS, venturePc, type PoolTrade, type Venture, type VentureMeta } from "./client";
import { chainNowSecs } from "./clock";

/** $DOUBLEPLUS, relaunched on Flap. It joins the board as a coin of its own,
 *  and its page (coin/HousePage.tsx) trades it through Flap's Portal. The
 *  first launch, on our v1 factory, is left off the lists; its page still
 *  opens by address. */
export const HOUSE = {
  token: "0xc40f1686f7252a372ea98164dd750897f83c7777" as Address,
  replaces: "0xc44cfd968a38c6b16a8be4677bbb87d0ebb42add" as Address,
  portal: "0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09" as Address,
  creator: "0x6ccB0De27ED0F794073d119774ac98b1fFCD09F0" as Address,
  url: "https://flap.sh/robinhood/0xc40f1686f7252a372ea98164dd750897f83c7777",
  launchBlock: 100224524n,
  createdAt: 1793206180,
  logo: "https://doubleplus.fun/doubleplus-logo.png",
};

export const isHouse = (a: string) => a.toLowerCase() === HOUSE.token;

const stateAbi = [{
  type: "function", name: "getTokenV9Safe", stateMutability: "view", inputs: [{ type: "address" }],
  outputs: [{ type: "tuple", components: [
    { name: "status", type: "uint8" }, { name: "reserve", type: "uint256" }, { name: "circulatingSupply", type: "uint256" },
    { name: "price", type: "uint256" }, { name: "tokenVersion", type: "uint8" }, { name: "r", type: "uint256" },
    { name: "h", type: "uint256" }, { name: "k", type: "uint256" }, { name: "dexSupplyThresh", type: "uint256" },
    { name: "quoteTokenAddress", type: "address" }, { name: "nativeToQuoteSwapEnabled", type: "bool" },
    { name: "extensionID", type: "bytes32" }, { name: "buyTaxRate", type: "uint256" }, { name: "sellTaxRate", type: "uint256" },
    { name: "pool", type: "address" }, { name: "progress", type: "uint256" }, { name: "lpFeeProfile", type: "uint8" },
    { name: "dexId", type: "uint8" }, { name: "bondingCurveFeeRate", type: "uint16" },
  ] }],
}] as const;

/** Flap's trading entry points. The older buy/sell/previewBuy revert with
 *  FeatureDisabled; a sell needs the Portal approved first. Checked on a
 *  mainnet fork: the quote is exactly what the swap delivers. */
export const portalAbi = [
  {
    type: "function", name: "swapExactInput", stateMutability: "payable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "inputToken", type: "address" }, { name: "outputToken", type: "address" },
      { name: "inputAmount", type: "uint256" }, { name: "minOutputAmount", type: "uint256" }, { name: "permitData", type: "bytes" },
    ] }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "quoteExactInput", stateMutability: "nonpayable",
    inputs: [{ name: "params", type: "tuple", components: [
      { name: "inputToken", type: "address" }, { name: "outputToken", type: "address" }, { name: "inputAmount", type: "uint256" },
    ] }],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function", name: "getFeeRate", stateMutability: "view", inputs: [],
    outputs: [{ name: "buyFeeRate", type: "uint256" }, { name: "sellFeeRate", type: "uint256" }],
  },
] as const;

const boughtEvent = parseAbiItem("event TokenBought(uint256 ts, address token, address buyer, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)");
const soldEvent = parseAbiItem("event TokenSold(uint256 ts, address token, address seller, uint256 amount, uint256 eth, uint256 fee, uint256 postPrice)");
const transferEvent = parseAbiItem("event Transfer(address indexed from, address indexed to, uint256 value)");

/** The relaunch keeps the first launch's description and links. */
let meta: VentureMeta | null = null;
async function houseMeta(): Promise<VentureMeta> {
  if (meta) return meta;
  const old = await loadVenture(HOUSE.replaces).then((v) => v.meta).catch(() => null);
  const m = { ...(old ?? {}), logo: HOUSE.logo };
  if (old) meta = m;
  return m;
}

/** The Flap coin as a board entry. An open curve to the board: Flap's
 *  reserve is the raise and its progress fixes the target. */
export async function loadHouseVenture(): Promise<Venture> {
  const [s, m] = await Promise.all([
    venturePc.readContract({ address: HOUSE.portal, abi: stateAbi, functionName: "getTokenV9Safe", args: [HOUSE.token] }),
    houseMeta(),
  ]);
  const listed = s.pool !== zeroAddress;
  // progress is the reserve's share of the graduation reserve, 1e18 = 100%.
  const target = s.progress > 0n ? (s.reserve * 10n ** 18n) / s.progress : 0n;
  return {
    address: HOUSE.token, sys: SYSTEMS[0], name: "DoublePlusFun", symbol: "DOUBLEPLUS",
    creator: HOUSE.creator, pair: zeroAddress, taxBps: 0, createdAt: HOUSE.createdAt, poolId: "0x" as Hex, meta: m,
    deadline: 0, priceWei: s.price, soldWhole: s.circulatingSupply / 10n ** 18n, remainingWhole: 1n,
    raisedWei: s.reserve, targetRaiseWei: listed ? s.reserve : target, finalized: listed, aborted: false,
    founderRaiseBps: 0, maxBuyWei: 0n, vesting: zeroAddress,
    policy: { devWallet: HOUSE.creator, buyTaxBps: Number(s.buyTaxRate), sellTaxBps: Number(s.sellTaxRate), devBps: 10_000, dividendBps: 0, liquidityBps: 0, mmBps: 0 },
    basePriceWei: 0n, slopeQ: 0n, mode: 1, swept: false, phase: listed ? "graduated" : "raising",
  };
}

/** Flap's trade log, read forward from the last block seen. The Portal logs
 *  every Flap coin's trades without an indexed token, so the filter is ours. */
const trades: PoolTrade[] = [];
let tradesTo = HOUSE.launchBlock - 1n;
export async function loadHouseTrades(): Promise<PoolTrade[]> {
  const latest = await venturePc.getBlockNumber();
  if (latest > tradesTo) {
    const logs = await venturePc.getLogs({ address: HOUSE.portal, events: [boughtEvent, soldEvent], fromBlock: tradesTo + 1n, toBlock: latest, strict: true });
    for (const l of logs) {
      if (l.args.token.toLowerCase() !== HOUSE.token) continue;
      const isBuy = l.eventName === "TokenBought";
      trades.push({
        isBuy, coinAmount: l.args.amount, pairAmount: l.args.eth, priceWei: l.args.postPrice,
        blockNumber: Number(l.blockNumber), ts: Number(l.args.ts), txHash: l.transactionHash,
      });
    }
    tradesTo = latest;
  }
  return [...trades];
}

/** Every holder's balance from the coin's own transfers. The Portal holds the
 *  unsold curve supply and is left out. */
const balances = new Map<string, bigint>();
let holdersTo = HOUSE.launchBlock - 1n;
export async function loadHouseHolders(): Promise<{ address: Address; balance: bigint }[]> {
  const latest = await venturePc.getBlockNumber();
  if (latest > holdersTo) {
    const logs = await venturePc.getLogs({ address: HOUSE.token, event: transferEvent, fromBlock: holdersTo + 1n, toBlock: latest, strict: true });
    for (const l of logs) {
      const from = l.args.from.toLowerCase(), to = l.args.to.toLowerCase();
      balances.set(from, (balances.get(from) ?? 0n) - l.args.value);
      balances.set(to, (balances.get(to) ?? 0n) + l.args.value);
    }
    holdersTo = latest;
  }
  const skip = new Set([zeroAddress, HOUSE.portal.toLowerCase()]);
  return [...balances].filter(([a, b]) => b > 0n && !skip.has(a))
    .map(([a, b]) => ({ address: a as Address, balance: b }))
    .sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0));
}

/** Trades in the last 24 hours, for the stat bar. */
export function dayStats(ts: PoolTrade[]): { volWei: bigint; buys: number; sells: number } {
  const cutoff = chainNowSecs() - 86_400;
  let volWei = 0n, buys = 0, sells = 0;
  for (const t of ts) if (t.ts >= cutoff) { volWei += t.pairAmount; if (t.isBuy) buys++; else sells++; }
  return { volWei, buys, sells };
}
