import {
  type Address,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  encodeFunctionData,
  parseAbi,
  toEventSelector,
  zeroAddress,
} from "viem";
import type { Candle, CandleInterval, PriceUpdate, TokenSummary, TradeRecord } from "@launchpad/sdk";
import { INTERVAL_SECONDS } from "@launchpad/sdk";

/**
 * Backend-free client for the StableLaunchpadFactory (Uniswap V3 on Stable
 * Mainnet). Reads tokens and prices straight from the factory and pools over
 * RPC; launches go through the factory and trades through the official
 * SwapRouter02. Shaped to match the V4 client surface so the existing pages
 * work unchanged; V4-only mechanics (dividends, stock rewards) return null.
 *
 * Decimals: the quote asset (ERC-20 USDT0) has 6 decimals while the UI works
 * in 18-decimal native units (USDT0 native gas is 18-dec; same balance).
 * This client converts at the router boundary.
 */

const FACTORY_ABI = parseAbi([
  "struct CreateParams { string name; string symbol; string metadataURI; address quote; uint256 marketCapUsd8; }",
  "function createToken(CreateParams p) returns (address token, address pool, uint256 positionId)",
  "function harvestFees(address token) returns (uint256, uint256, uint256, uint256)",
  "function tokenCount() view returns (uint256)",
  "function allTokens(uint256) view returns (address)",
  "function listings(address) view returns (address creator, address quote, address pool, uint256 positionId, uint64 createdAt, bool tokenIsToken0)",
  "function quoteAssets(address) view returns (bool approved, uint64 usdPrice8, uint8 decimals)",
  // Owner console
  "function owner() view returns (address)",
  "function feeRecipient() view returns (address)",
  "function launchesPaused() view returns (bool)",
  "function pause()",
  "function resume()",
  "function setFeeRecipient(address newRecipient)",
  "function setQuoteAsset(address quote, bool approved, uint64 usdPrice8)",
  "function collectFees(address token) returns (uint256, uint256)",
  "function recoverERC20(address asset, uint256 amount)",
  "function recoverNative()",
]);

const ERC20_ABI = parseAbi([
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function metadataURI() view returns (string)",
  "function approve(address, uint256) returns (bool)",
  "function allowance(address, address) view returns (uint256)",
]);

const POOL_ABI = parseAbi([
  "function slot0() view returns (uint160 sqrtPriceX96, int24 tick, uint16, uint16, uint16, uint8, bool)",
  "function liquidity() view returns (uint128)",
  "event Swap(address indexed sender, address indexed recipient, int256 amount0, int256 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick)",
]);

const ROUTER_ABI = parseAbi([
  "struct ExactInputSingleParams { address tokenIn; address tokenOut; uint24 fee; address recipient; uint256 amountIn; uint256 amountOutMinimum; uint160 sqrtPriceLimitX96; }",
  "function exactInputSingle(ExactInputSingleParams params) payable returns (uint256 amountOut)",
  "function multicall(bytes[] data) payable returns (bytes[] results)",
  "function unwrapWETH9(uint256 amountMinimum, address recipient) payable",
]);

/** Arc flavor: ArcLaunchpadFactory + ArcSwapRouter on DyorSwap V3 pools with
 *  the native-USDC quote. Differs from Stable in the listings shape, the count
 *  view's name, and the router's native buy/sell entry points. */
const ARC_V3 = String(import.meta.env.VITE_V3_FLAVOR ?? "") === "arc";

const ARC_FACTORY_ABI = parseAbi([
  "function totalTokens() view returns (uint256)",
  "function listings(address) view returns (address creator, address quote, address pool, int24 tickLower, int24 tickUpper, uint64 createdAt, bool tokenIsToken0)",
  "function emergencyRecover(address asset, uint256 amount, address to)",
]);

const ARC_ROUTER_ABI = parseAbi([
  "function buy(address token, uint256 minOut) payable returns (uint256)",
  "function sell(address token, uint256 amountIn, uint256 minOut) returns (uint256)",
]);

const Q96 = 2n ** 96n;
/** SwapRouter02 sentinel: send swap output to the router for a follow-up step. */
const ADDRESS_THIS = "0x0000000000000000000000000000000000000002" as Address;
/** Quote-wei → 18-dec native-wei gap (10^(18 - quote decimals)). */
const DEC_GAP = 10n ** BigInt(18 - Number(import.meta.env.VITE_QUOTE_DECIMALS ?? 6));
/** True when the quote asset is the chain's wrapped native (e.g. WETH on
 *  Robinhood): buys pay native value and sells unwrap back to native. */
const QUOTE_IS_WNATIVE = String(import.meta.env.VITE_QUOTE_IS_WNATIVE ?? "") === "true";
/** Max block span of one getLogs request (RPC-dependent; Stable caps at 500,
 *  Robinhood accepts millions). */
const LOGS_WINDOW = Number(import.meta.env.VITE_LOGS_WINDOW ?? 500);
/** Total recent-trade span scanned up front, in blocks. */
const SCAN_SPAN = Number(import.meta.env.VITE_SCAN_SPAN ?? 10_000);
const TRADE_SCAN_WINDOWS = Math.max(1, Math.ceil(SCAN_SPAN / LOGS_WINDOW));

export interface StableAddresses {
  factory: Address;
  swapRouter: Address;
  quote: Address; // quote ERC-20 (USDT0 on Stable, WETH on Robinhood)
}

interface Core {
  address: Address;
  creator: Address;
  pool: Address;
  positionId: bigint;
  createdAt: number;
  tokenIsToken0: boolean;
  name: string;
  symbol: string;
  metadataURI: string;
}

export class StableV3Client {
  readonly publicClient: PublicClient;
  readonly addresses: StableAddresses;
  private walletClient?: WalletClient;
  private cores = new Map<string, Core>();
  private coreCount = 0;
  private coresInflight: Promise<Core[]> | null = null;
  private priceCache = new Map<string, { at: number; price: bigint }>();
  private tradesCache = new Map<string, { at: number; trades: TradeRecord[] }>();
  private tradesInflight = new Map<string, Promise<TradeRecord[]>>();
  /** Per-token live watcher: one incremental getLogs + slot0 per tick while
   *  any subscriber (trades list, price header) is mounted. */
  private watchers = new Map<
    string,
    {
      timer: ReturnType<typeof setInterval>;
      lastBlock: bigint;
      busy: boolean;
      tradeCbs: Set<(t: TradeRecord) => void>;
      priceCbs: Set<(u: PriceUpdate) => void>;
    }
  >();
  private holdersCache = new Map<string, { at: number; count: number }>();
  private deepScanned = new Set<string>();
  /** USD per whole quote token, read from the factory's quote registry ($1 on
   *  Stable, live ETH price on Robinhood). */
  private quoteUsd = 1;
  private quoteUsdLoaded = false;
  /** Observed seconds per block, refreshed by each trade scan. Stable is a
   *  steady 0.7s; Orbit chains mint blocks on demand so this varies. */
  private avgBlockTime = 0.7;

  constructor(publicClient: PublicClient, addresses: StableAddresses) {
    this.publicClient = publicClient;
    this.addresses = addresses;
  }

  // -- swap-log source with receipt fallback -----------------------------
  //
  // Some Arc RPCs ship with eth_getLogs disabled. When a log scan fails, the
  // method is parked (persisted across reloads) and swap logs come from an
  // incremental walk over recent block receipts instead: one shared walk
  // feeds every pool's trade feed. History older than the walk's backfill
  // window is unavailable in that mode.

  private static SWAP_TOPIC = toEventSelector(POOL_ABI[2] as any);
  private logsBrokenUntil = (() => {
    try {
      return Number(globalThis.localStorage?.getItem("lp.logsBrokenUntil") ?? 0) || 0;
    } catch {
      return 0;
    }
  })();
  private parkLogs() {
    this.logsBrokenUntil = Date.now() + 300_000;
    try {
      globalThis.localStorage?.setItem("lp.logsBrokenUntil", String(this.logsBrokenUntil));
    } catch { /* private mode */ }
  }
  private logsParked(): boolean {
    return Date.now() < this.logsBrokenUntil;
  }
  private receiptUpTo = 0n;
  private receiptLogsByPool = new Map<string, any[]>();
  private receiptInflight: Promise<void> | null = null;

  private async scanReceiptsTo(latest: bigint): Promise<void> {
    while (this.receiptInflight) await this.receiptInflight;
    if (this.receiptUpTo >= latest) return;
    this.receiptInflight = (async () => {
      let from = this.receiptUpTo === 0n ? latest - 240n : this.receiptUpTo + 1n;
      if (from < 1n) from = 1n;
      if (latest - from > 900n) from = latest - 900n;
      const blocks: bigint[] = [];
      for (let b = from; b <= latest; b++) blocks.push(b);
      for (let i = 0; i < blocks.length; i += 50) {
        const chunk = blocks.slice(i, i + 50);
        const settled = await Promise.allSettled(
          chunk.map(
            (b) =>
              this.publicClient.request({
                method: "eth_getBlockReceipts" as any,
                params: [`0x${b.toString(16)}`] as any,
              }) as Promise<any[]>,
          ),
        );
        for (const r of settled) {
          if (r.status !== "fulfilled" || !Array.isArray(r.value)) continue;
          for (const rec of r.value) {
            for (const lg of rec?.logs ?? []) {
              if (lg.topics?.[0] !== StableV3Client.SWAP_TOPIC) continue;
              const poolKey = (lg.address ?? "").toLowerCase();
              const arr = this.receiptLogsByPool.get(poolKey) ?? [];
              arr.push(lg);
              this.receiptLogsByPool.set(poolKey, arr);
            }
          }
        }
      }
      this.receiptUpTo = latest;
    })().finally(() => (this.receiptInflight = null));
    await this.receiptInflight;
  }

  /** Swap logs for one pool over [fromBlock, toBlock], shaped like viem
   *  getLogs output. Uses getLogs when healthy; receipts otherwise. */
  private async poolSwapLogs(pool: Address, fromBlock: bigint, toBlock: bigint): Promise<any[]> {
    if (!this.logsParked()) {
      try {
        return (await this.publicClient.getLogs({
          address: pool,
          event: POOL_ABI[2] as any,
          fromBlock,
          toBlock,
        })) as any[];
      } catch {
        this.parkLogs();
      }
    }
    // Await the walk so the first trades/candles response already carries the
    // recent history instead of arriving empty and filling in a poll later.
    // (Explore never fetches per-token trades on this client, so nothing
    // user-blocking waits on this except the chart that needs the data.)
    await this.scanReceiptsTo(toBlock).catch(() => undefined);
    const upTo = this.receiptUpTo;
    return (this.receiptLogsByPool.get(pool.toLowerCase()) ?? [])
      .filter((lg) => BigInt(lg.blockNumber) >= fromBlock && BigInt(lg.blockNumber) <= (toBlock < upTo ? toBlock : upTo))
      .map((lg) => {
        const d = decodeEventLog({ abi: [POOL_ABI[2]] as any, data: lg.data, topics: lg.topics }) as any;
        return {
          args: d.args,
          blockNumber: BigInt(lg.blockNumber),
          transactionHash: lg.transactionHash,
          logIndex: Number(lg.logIndex),
        };
      });
  }

  connectWallet(wc: WalletClient) {
    this.walletClient = wc;
  }
  private wallet(): WalletClient {
    if (!this.walletClient?.account) throw new Error("No wallet connected.");
    return this.walletClient;
  }

  // -- reads ------------------------------------------------------------

  private loadCores(): Promise<Core[]> {
    // Single-flight: Explore fires two token queries at mount; share one scan.
    if (!this.coresInflight) {
      this.coresInflight = this._loadCores().finally(() => {
        this.coresInflight = null;
      });
    }
    return this.coresInflight;
  }

  private async _loadCores(): Promise<Core[]> {
    if (!this.quoteUsdLoaded) {
      // One-time: the factory knows the quote's USD price (8 decimals).
      this.publicClient
        .readContract({ address: this.addresses.factory, abi: FACTORY_ABI, functionName: "quoteAssets", args: [this.addresses.quote] })
        .then((q) => {
          const [, usdPrice8] = q as unknown as [boolean, bigint, number];
          if (usdPrice8 > 0n) {
            this.quoteUsd = Number(usdPrice8) / 1e8;
            this.quoteUsdLoaded = true;
          }
        })
        .catch(() => {});
    }
    const count = Number(
      ARC_V3
        ? await this.publicClient.readContract({
            address: this.addresses.factory,
            abi: ARC_FACTORY_ABI,
            functionName: "totalTokens",
          })
        : await this.publicClient.readContract({
            address: this.addresses.factory,
            abi: FACTORY_ABI,
            functionName: "tokenCount",
          }),
    );
    if (count > this.coreCount) {
      const idxs = Array.from({ length: count - this.coreCount }, (_, i) => this.coreCount + i);
      const addrs = await Promise.all(
        idxs.map((i) =>
          this.publicClient.readContract({
            address: this.addresses.factory,
            abi: FACTORY_ABI,
            functionName: "allTokens",
            args: [BigInt(i)],
          }),
        ),
      );
      await Promise.all(
        addrs.map(async (addr) => {
          const a = addr as Address;
          const [listing, name, symbol, metadataURI] = await Promise.all([
            this.publicClient.readContract({
              address: this.addresses.factory,
              abi: ARC_V3 ? ARC_FACTORY_ABI : FACTORY_ABI,
              functionName: "listings",
              args: [a],
            }),
            this.publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "name" }),
            this.publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "symbol" }),
            this.publicClient.readContract({ address: a, abi: ERC20_ABI, functionName: "metadataURI" }).catch(() => ""),
          ]);
          // Arc listings identify the position by tick range, Stable by NFT id;
          // the client only needs the shared fields.
          let creator: Address, pool: Address, positionId: bigint, createdAt: bigint, tokenIsToken0: boolean;
          if (ARC_V3) {
            const l = listing as unknown as [Address, Address, Address, number, number, bigint, boolean];
            [creator, , pool, , , createdAt, tokenIsToken0] = l;
            positionId = 0n;
          } else {
            [creator, , pool, positionId, createdAt, tokenIsToken0] = listing as unknown as [
              Address, Address, Address, bigint, bigint, boolean,
            ];
          }
          this.cores.set(a.toLowerCase(), {
            address: a, creator, pool, positionId,
            createdAt: Number(createdAt), tokenIsToken0,
            name: name as string, symbol: symbol as string, metadataURI: metadataURI as string,
          });
        }),
      );
      this.coreCount = count;
    }
    return [...this.cores.values()];
  }

  /** Price in native wei (18d) per whole token, from the live pool. Cached
   *  briefly so list + detail views don't refetch slot0 per render. */
  private async priceWei(core: Core): Promise<bigint> {
    const key = core.address.toLowerCase();
    const hit = this.priceCache.get(key);
    if (hit && Date.now() - hit.at < 8_000) return hit.price;
    const price = await this.readPriceWei(core);
    this.priceCache.set(key, { at: Date.now(), price });
    return price;
  }

  private async readPriceWei(core: Core): Promise<bigint> {
    const [sqrtPriceX96] = (await this.publicClient.readContract({
      address: core.pool, abi: POOL_ABI, functionName: "slot0",
    })) as unknown as [bigint];
    // token0 case: quote6-per-tokenWei ratio = (sqrtP/2^96)^2 → per whole
    // token ×1e18, to 18d ×1e12.
    if (core.tokenIsToken0) {
      return (((sqrtPriceX96 * sqrtPriceX96) / Q96) * 10n ** 18n * DEC_GAP) / Q96;
    }
    const num = Q96 * Q96 * 10n ** 18n * DEC_GAP;
    return num / (sqrtPriceX96 * sqrtPriceX96);
  }

  /** Volume/tx stats from the cached trade window plus the last holder count.
   *  Cheap; pure array math over what the scan/watcher already fetched. */
  private statsFromCache(key: string) {
    const trades = (this.tradesCache.get(key) ?? this.loadPersistedTrades(key))?.trades ?? [];
    const dayAgo = Math.floor(Date.now() / 1000) - 86_400;
    let volTotal = 0n;
    let vol24 = 0n;
    let tx24 = 0;
    for (const t of trades) {
      const v = BigInt(t.nativeAmountWei);
      volTotal += v;
      if (t.timestamp >= dayAgo) {
        vol24 += v;
        tx24 += 1;
      }
    }
    return { volTotal, vol24, tx24, holders: this.holdersCache.get(key)?.count };
  }

  /** Count holders among addresses we've seen trade (Swap `recipient`), the
   *  creator, and the pool. The RPC's 500-block getLogs cap rules out a full
   *  Transfer-history scan, so this converges as trading is observed; traders
   *  seen once are remembered in localStorage so the count doesn't shrink when
   *  the scan window slides past their trades. */
  private async refreshHolders(core: Core): Promise<number> {
    const key = core.address.toLowerCase();
    const hit = this.holdersCache.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.count;
    const trades = (this.tradesCache.get(key) ?? this.loadPersistedTrades(key))?.trades ?? [];
    const candidates = new Set<string>();
    for (const t of trades) {
      if (t.trader && t.trader !== zeroAddress) candidates.add(t.trader.toLowerCase());
    }
    const storeKey = `steady:holdercands:${key}`;
    try {
      for (const a of JSON.parse(localStorage.getItem(storeKey) ?? "[]") as string[]) candidates.add(a);
    } catch { /* corrupt entry; rebuild from trades */ }
    try {
      localStorage.setItem(storeKey, JSON.stringify([...candidates].slice(0, 200)));
    } catch { /* storage full */ }
    candidates.add(core.creator.toLowerCase());
    const addrs = [...candidates].slice(0, 60) as Address[];
    const balances = await Promise.all(
      addrs.map((a) =>
        this.publicClient
          .readContract({ address: core.address, abi: ERC20_ABI, functionName: "balanceOf", args: [a] })
          .catch(() => 0n),
      ),
    );
    let count = 1; // the pool always holds the curve's supply
    for (const b of balances) if ((b as bigint) > 0n) count += 1;
    this.holdersCache.set(key, { at: Date.now(), count });
    return count;
  }

  private async summary(core: Core): Promise<TokenSummary> {
    const price = await this.priceWei(core).catch(() => 0n);
    const supply = 1_000_000_000n * 10n ** 18n;
    const mcapWei = (price * supply) / 10n ** 18n;
    const usd = (Number(mcapWei) / 1e18) * this.quoteUsd;
    const stats = this.statsFromCache(core.address.toLowerCase());
    let metadata: Record<string, unknown> = {};
    try { metadata = JSON.parse(core.metadataURI || "{}"); } catch { /* opaque URI */ }
    return {
      address: core.address,
      name: core.name,
      symbol: core.symbol,
      creator: core.creator,
      pool: core.pool,
      // Fee expressed in trade-tax bps for the UI (1% pool tier).
      feeTier: 100,
      createdAt: core.createdAt,
      featured: false,
      metadata: metadata as TokenSummary["metadata"],
      totalSupply: supply.toString(),
      priceWei: price.toString(),
      priceUsd: String((Number(price) / 1e18) * this.quoteUsd),
      marketCapUsd: String(usd),
      liquidityWei: "0",
      volume24hWei: stats.vol24.toString(),
      volumeTotalWei: stats.volTotal.toString(),
      txCount24h: stats.tx24,
      holderCount: stats.holders ?? 0,
      limitsActive: false,
      remainingToGraduationUsd: "0",
      priceChange24hPct: null,
      creatorFeesWei: "0",
    } as unknown as TokenSummary;
  }

  async getTokens(opts?: { sort?: string; limit?: number }): Promise<TokenSummary[]> {
    const cores = await this.loadCores();
    const list = await Promise.all(cores.map((c) => this.summary(c)));
    const sort = opts?.sort ?? "new";
    if (sort === "mcap" || sort === "marketCap") list.sort((a, b) => Number(b.marketCapUsd) - Number(a.marketCapUsd));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    const out = list.slice(0, opts?.limit ?? 60);
    // Warm trade scans for the visible tokens so volume fills in on the list's
    // next poll without blocking this render. Bounded to stay well inside the
    // RPC rate budget.
    for (const t of out.slice(0, 12)) this.getTrades(t.address, { limit: 50 }).catch(() => {});
    return out;
  }

  async getToken(token: string): Promise<TokenSummary | null> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    if (!core) return null;
    // Volume and holders are derived from the trade window and live balances,
    // so resolve those before shaping the summary.
    await this.getTrades(token, { limit: 50 }).catch(() => {});
    await this.refreshHolders(core).catch(() => {});
    // History beyond the recent window backfills in the background; the
    // watcher's next price tick carries the corrected stats to the page.
    this.deepScan(core).catch(() => {});
    return this.summary(core);
  }

  /** One-time-per-session backfill past the recent window, back toward the
   *  token's creation (capped). Quiet tokens whose trades predate the live
   *  window would otherwise read $0 volume and no holders. */
  private async deepScan(core: Core) {
    const key = core.address.toLowerCase();
    if (this.deepScanned.has(key)) return;
    // Receipts mode has no deep history to scan; retry if logs recover.
    if (this.logsParked()) return;
    this.deepScanned.add(key);
    const head = await this.publicClient.getBlockNumber();
    const ageBlocks = Math.ceil((Date.now() / 1000 - core.createdAt) / this.avgBlockTime) + LOGS_WINDOW;
    const totalWindows = Math.min(Math.ceil(ageBlocks / LOGS_WINDOW), 200);
    if (totalWindows <= TRADE_SCAN_WINDOWS) return;
    const headTs = Math.floor(Date.now() / 1000);
    const W = BigInt(LOGS_WINDOW);
    const found: TradeRecord[] = [];
    // Sequential batches keep this well under the RPC's rate budget.
    for (let start = TRADE_SCAN_WINDOWS; start < totalWindows; start += 25) {
      const batch = [];
      for (let w = start; w < Math.min(start + 25, totalWindows); w += 1) {
        const to = head - BigInt(w) * W;
        if (to <= 0n) break;
        const from = to - W + 1n > 0n ? to - W + 1n : 0n;
        batch.push(this.poolSwapLogs(core.pool, from, to).catch(() => []));
      }
      for (const logs of await Promise.all(batch)) {
        for (const log of logs) found.push(this.logToTrade(core, log, head, headTs));
      }
    }
    if (found.length === 0) return;
    const entry = this.tradesCache.get(key) ?? this.loadPersistedTrades(key) ?? { at: 0, trades: [] };
    const seen = new Set(entry.trades.map((t) => t.id));
    const fresh = found.filter((t) => !seen.has(t.id));
    if (fresh.length === 0) return;
    entry.trades = [...entry.trades, ...fresh]
      .sort((a, b) => b.blockNumber - a.blockNumber)
      .slice(0, 500);
    this.tradesCache.set(key, entry);
    this.persistTrades(key, entry);
    // A mounted trades list only hears about trades through its subscription,
    // so push the backfill through it too (oldest first; the list prepends).
    const w = this.watchers.get(key);
    if (w) {
      for (const t of [...fresh].sort((a, b) => a.blockNumber - b.blockNumber)) {
        for (const cb of w.tradeCbs) cb(t);
      }
    }
    this.holdersCache.delete(key);
    await this.refreshHolders(core).catch(() => {});
  }

  /** Recent trades from pool Swap events. The public RPC caps getLogs at 500
   *  blocks, so a bounded window of recent history is scanned; all windows in
   *  parallel, results cached briefly and shared with the candle builder.
   *  Timestamps are estimated from the head block and Stable's ~0.7s block
   *  time instead of a per-block lookup. */
  async getTrades(token: string, opts?: { limit?: number }): Promise<TradeRecord[]> {
    const key = token.toLowerCase();
    const hit = this.tradesCache.get(key) ?? this.loadPersistedTrades(key);
    const age = hit ? Date.now() - hit.at : Infinity;
    if (hit && age < 15_000) return hit.trades.slice(0, opts?.limit ?? 50);
    let inflight = this.tradesInflight.get(key);
    if (!inflight) {
      inflight = this.scanTrades(key).finally(() => this.tradesInflight.delete(key));
      this.tradesInflight.set(key, inflight);
    }
    // Stale-while-revalidate: a recent-enough cached list renders instantly
    // while the fresh scan replaces it for the next read.
    if (hit && age < 120_000) return hit.trades.slice(0, opts?.limit ?? 50);
    const trades = await inflight;
    return trades.slice(0, opts?.limit ?? 50);
  }

  private loadPersistedTrades(key: string): { at: number; trades: TradeRecord[] } | null {
    try {
      // localStorage (not session) so backfilled history; and the volume
      // stats derived from it; survives across visits.
      const raw = localStorage.getItem(`steady:trades:${key}`) ?? sessionStorage.getItem(`steady:trades:${key}`);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as { at: number; trades: TradeRecord[] };
      this.tradesCache.set(key, parsed);
      return parsed;
    } catch {
      return null;
    }
  }

  private async scanTrades(key: string): Promise<TradeRecord[]> {
    await this.loadCores();
    const core = this.cores.get(key);
    if (!core) return [];
    const [head, headBlock] = await Promise.all([
      this.publicClient.getBlockNumber(),
      this.publicClient.getBlock().catch(() => null),
    ]);
    const headTs = headBlock ? Number(headBlock.timestamp) : Math.floor(Date.now() / 1000);

    const W = BigInt(LOGS_WINDOW);
    const windows = Array.from({ length: TRADE_SCAN_WINDOWS }, (_, w) => {
      const to = head - BigInt(w) * W;
      if (to <= 0n) return null;
      const from = to - W + 1n > 0n ? to - W + 1n : 0n;
      return { from, to };
    }).filter(Boolean) as Array<{ from: bigint; to: bigint }>;

    // Calibrate seconds-per-block from the span's oldest block so trade
    // timestamps interpolate correctly on chains without a fixed cadence.
    const spanStart = windows[windows.length - 1]?.from ?? 0n;
    if (head > spanStart) {
      await this.publicClient
        .getBlock({ blockNumber: spanStart })
        .then((b) => {
          const dt = headTs - Number(b.timestamp);
          const db = Number(head - spanStart);
          if (dt > 0 && db > 0) this.avgBlockTime = Math.min(60, Math.max(0.05, dt / db));
        })
        .catch(() => {});
    }

    const results = this.logsParked()
      ? [await this.poolSwapLogs(core.pool, windows[windows.length - 1]?.from ?? 0n, head).catch(() => [])]
      : await Promise.all(windows.map((w) => this.poolSwapLogs(core.pool, w.from, w.to).catch(() => [])));

    // Estimated timestamps drift between scans (they're derived from the
    // moving head block), which would shift candle buckets backwards and make
    // the chart reject "out of order" updates. Keep the first timestamp a
    // trade was ever assigned, and keep trades that slid out of the window.
    const prev = (this.tradesCache.get(key) ?? this.loadPersistedTrades(key))?.trades ?? [];
    const prevById = new Map(prev.map((t) => [t.id, t]));
    const out: TradeRecord[] = [];
    for (const logs of results) {
      for (const log of logs) {
        const t = this.logToTrade(core, log, head, headTs);
        const old = prevById.get(t.id);
        out.push(old ? { ...t, timestamp: old.timestamp } : t);
      }
    }
    const ids = new Set(out.map((t) => t.id));
    for (const t of prev) if (!ids.has(t.id)) out.push(t);
    out.sort((a, b) => b.blockNumber - a.blockNumber);
    const entry = { at: Date.now(), trades: out.slice(0, 500) };
    this.tradesCache.set(key, entry);
    this.persistTrades(key, entry);
    return entry.trades;
  }

  private persistTrades(key: string, entry: { at: number; trades: TradeRecord[] }) {
    try {
      localStorage.setItem(`steady:trades:${key}`, JSON.stringify({ at: entry.at, trades: entry.trades.slice(0, 100) }));
    } catch { /* storage full; in-memory cache still works */ }
  }

  private logToTrade(
    core: Core,
    log: {
      args: unknown;
      blockNumber: bigint | null;
      transactionHash: `0x${string}` | null;
      logIndex: number | null;
    },
    head: bigint,
    headTs: number,
  ): TradeRecord {
    const { recipient, amount0, amount1, sqrtPriceX96 } = log.args as {
      recipient: Address;
      amount0: bigint;
      amount1: bigint;
      sqrtPriceX96: bigint;
    };
    const tokenDelta = core.tokenIsToken0 ? amount0 : amount1;
    const quoteDelta = core.tokenIsToken0 ? amount1 : amount0;
    const isBuy = tokenDelta < 0n; // pool pays tokens out on a buy
    const price = core.tokenIsToken0
      ? (((sqrtPriceX96 * sqrtPriceX96) / Q96) * 10n ** 18n * DEC_GAP) / Q96
      : (Q96 * Q96 * 10n ** 18n * DEC_GAP) / (sqrtPriceX96 * sqrtPriceX96);
    const blockNumber = log.blockNumber ?? head;
    return {
      id: `${log.transactionHash}-${log.logIndex}`,
      token: core.address,
      // SwapRouter02 sets recipient to the trader's wallet.
      trader: recipient ?? zeroAddress,
      isBuy,
      nativeAmountWei: ((quoteDelta < 0n ? -quoteDelta : quoteDelta) * DEC_GAP).toString(),
      tokenAmount: (tokenDelta < 0n ? -tokenDelta : tokenDelta).toString(),
      feeWei: "0",
      priceWei: price.toString(),
      blockNumber: Number(blockNumber),
      txHash: log.transactionHash ?? "0x",
      timestamp: Math.max(0, headTs - Math.round(Number(head - blockNumber) * this.avgBlockTime)),
    };
  }

  /** Candles from the recent-trade window plus a live closing candle. */
  async getCandles(token: string, interval: CandleInterval, opts?: { limit?: number }): Promise<Candle[]> {
    const secs = INTERVAL_SECONDS[interval] ?? 60;
    // Shares the cached trade scan with the trades list; no duplicate work.
    const trades = await this.getTrades(token, { limit: 500 });
    const core = this.cores.get(token.toLowerCase());
    const live = core ? await this.priceWei(core).catch(() => 0n) : 0n;
    // Candle prices/volumes are whole units (native per token, native volume),
    // matching the V4 client so mcapScale means the same thing for both.
    const buckets = new Map<number, Candle>();
    for (const t of [...trades].sort((a, b) => a.timestamp - b.timestamp)) {
      const bucket = Math.floor(t.timestamp / secs) * secs;
      const price = Number(t.priceWei) / 1e18;
      const vol = Number(t.nativeAmountWei) / 1e18;
      const c = buckets.get(bucket);
      if (!c) {
        buckets.set(bucket, { time: bucket, open: String(price), high: String(price), low: String(price), close: String(price), volume: String(vol) });
      } else {
        c.high = String(Math.max(Number(c.high), price));
        c.low = String(Math.min(Number(c.low), price));
        c.close = String(price);
        c.volume = String(Number(c.volume) + vol);
      }
    }
    const now = Math.floor(Date.now() / 1000);
    const nowBucket = Math.floor(now / secs) * secs;

    // Only real trade candles; no synthetic filler bars. For readability,
    // chain each candle's open to the previous close so a price move between
    // trades renders as a body instead of a zero-height dash.
    const ordered = [...buckets.values()].sort((a, b) => a.time - b.time);
    for (let i = 1; i < ordered.length; i += 1) {
      const prevClose = ordered[i - 1].close;
      const c = ordered[i];
      c.open = prevClose;
      c.high = String(Math.max(Number(c.high), Number(prevClose)));
      c.low = String(Math.min(Number(c.low), Number(prevClose)));
    }

    if (live > 0n) {
      const p = Number(live) / 1e18;
      const last = ordered[ordered.length - 1];
      if (last && last.time === nowBucket) {
        // Tick the in-progress candle with the live pool price so the chart
        // moves between trades, not only when a swap lands.
        last.close = String(p);
        last.high = String(Math.max(Number(last.high), p));
        last.low = String(Math.min(Number(last.low), p));
      } else {
        // Current-price candle opening at the last close; live data, not filler.
        const open = last ? last.close : String(p);
        ordered.push({
          time: nowBucket,
          open,
          high: String(Math.max(Number(open), p)),
          low: String(Math.min(Number(open), p)),
          close: String(p),
          volume: "0",
        });
      }
    }
    return ordered.slice(-(opts?.limit ?? 500));
  }

  // -- writes -----------------------------------------------------------

  /** Launch a token on the Stable factory (default $3,000 market cap). */
  async createToken(p: { name: string; symbol: string; metadataURI: string }): Promise<`0x${string}`> {
    const wc = this.wallet();
    return wc.writeContract({
      address: this.addresses.factory,
      abi: FACTORY_ABI,
      functionName: "createToken",
      args: [{ name: p.name, symbol: p.symbol, metadataURI: p.metadataURI, quote: this.addresses.quote, marketCapUsd8: 0n }],
      chain: wc.chain,
      account: wc.account!,
    });
  }

  private async ensureAllowance(owner: Address, tokenAddr: Address, amount: bigint) {
    const wc = this.wallet();
    const allowance = (await this.publicClient.readContract({
      address: tokenAddr, abi: ERC20_ABI, functionName: "allowance", args: [owner, this.addresses.swapRouter],
    })) as bigint;
    if (allowance < amount) {
      const hash = await wc.writeContract({
        address: tokenAddr, abi: ERC20_ABI, functionName: "approve",
        args: [this.addresses.swapRouter, amount], chain: wc.chain, account: wc.account!,
      });
      await this.publicClient.waitForTransactionReceipt({ hash });
    }
  }

  /** Buy `token` spending `nativeWei` (18d) of the quote on the router. When
   *  the quote is the wrapped native, the trade pays plain native value and
   *  SwapRouter02 wraps it internally; no approval needed. */
  async buyToken(token: Address, nativeWei: bigint, minOut: bigint): Promise<`0x${string}`> {
    const wc = this.wallet();
    const me = wc.account!.address as Address;
    if (ARC_V3) {
      // ArcSwapRouter takes plain native value; no quote approval at all.
      if (nativeWei / DEC_GAP === 0n) throw new Error("Amount too small.");
      return wc.writeContract({
        address: this.addresses.swapRouter, abi: ARC_ROUTER_ABI, functionName: "buy",
        args: [token, minOut], value: nativeWei, chain: wc.chain, account: wc.account!,
      });
    }
    const amountIn = nativeWei / DEC_GAP;
    if (amountIn === 0n) throw new Error("Amount too small.");
    if (!QUOTE_IS_WNATIVE) await this.ensureAllowance(me, this.addresses.quote, amountIn);
    return wc.writeContract({
      address: this.addresses.swapRouter, abi: ROUTER_ABI, functionName: "exactInputSingle",
      args: [{ tokenIn: this.addresses.quote, tokenOut: token, fee: 10_000, recipient: me, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
      value: QUOTE_IS_WNATIVE ? nativeWei : undefined,
      chain: wc.chain, account: wc.account!,
    });
  }

  /** Sell `amountIn` token wei for the quote; `minOut` is native wei (18d).
   *  When the quote is the wrapped native, the swap lands in the router and a
   *  second multicall step unwraps it straight to the seller as native. */
  async sellToken(token: Address, amountIn: bigint, minOut: bigint): Promise<`0x${string}`> {
    const wc = this.wallet();
    const me = wc.account!.address as Address;
    await this.ensureAllowance(me, token, amountIn);
    if (ARC_V3) {
      // ArcSwapRouter pays the seller in plain native; minOut is native wei.
      return wc.writeContract({
        address: this.addresses.swapRouter, abi: ARC_ROUTER_ABI, functionName: "sell",
        args: [token, amountIn, minOut], chain: wc.chain, account: wc.account!,
      });
    }
    if (!QUOTE_IS_WNATIVE) {
      return wc.writeContract({
        address: this.addresses.swapRouter, abi: ROUTER_ABI, functionName: "exactInputSingle",
        args: [{ tokenIn: token, tokenOut: this.addresses.quote, fee: 10_000, recipient: me, amountIn, amountOutMinimum: minOut / DEC_GAP, sqrtPriceLimitX96: 0n }],
        chain: wc.chain, account: wc.account!,
      });
    }
    const swap = encodeFunctionData({
      abi: ROUTER_ABI, functionName: "exactInputSingle",
      args: [{ tokenIn: token, tokenOut: this.addresses.quote, fee: 10_000, recipient: ADDRESS_THIS, amountIn, amountOutMinimum: minOut, sqrtPriceLimitX96: 0n }],
    });
    const unwrap = encodeFunctionData({
      abi: ROUTER_ABI, functionName: "unwrapWETH9",
      args: [minOut, me],
    });
    return wc.writeContract({
      address: this.addresses.swapRouter, abi: ROUTER_ABI, functionName: "multicall",
      args: [[swap, unwrap]],
      chain: wc.chain, account: wc.account!,
    });
  }

  /** Distribute accrued pool fees 80/20 creator/platform (permissionless). */
  async claimCreatorFees(token: Address): Promise<`0x${string}`> {
    const wc = this.wallet();
    return wc.writeContract({
      address: this.addresses.factory, abi: FACTORY_ABI, functionName: "harvestFees",
      args: [token], chain: wc.chain, account: wc.account!,
    });
  }

  // -- Owner console ----------------------------------------------------

  /** Factory owner-console snapshot. */
  async adminInfo(): Promise<{ owner: Address; feeRecipient: Address; paused: boolean; tokenCount: number }> {
    const F = this.addresses.factory;
    const [owner, feeRecipient, paused, count] = await Promise.all([
      this.publicClient.readContract({ address: F, abi: FACTORY_ABI, functionName: "owner" }),
      this.publicClient.readContract({ address: F, abi: FACTORY_ABI, functionName: "feeRecipient" }),
      this.publicClient.readContract({ address: F, abi: FACTORY_ABI, functionName: "launchesPaused" }),
      ARC_V3
        ? this.publicClient.readContract({ address: F, abi: ARC_FACTORY_ABI, functionName: "totalTokens" })
        : this.publicClient.readContract({ address: F, abi: FACTORY_ABI, functionName: "tokenCount" }),
    ]);
    return {
      owner: owner as Address,
      feeRecipient: feeRecipient as Address,
      paused: paused as boolean,
      tokenCount: Number(count),
    };
  }

  /** Owner-gated (and harvest) factory calls from the connected wallet. */
  async adminCall(
    functionName:
      | "pause"
      | "resume"
      | "setFeeRecipient"
      | "setQuoteAsset"
      | "collectFees"
      | "recoverERC20"
      | "recoverNative"
      | "harvestFees",
    args: unknown[] = [],
  ): Promise<`0x${string}`> {
    const wc = this.wallet();
    // The Arc factory folds the recover pair into emergencyRecover(asset,
    // amount, to); recovered assets go to the connected owner wallet.
    if (ARC_V3 && (functionName === "recoverERC20" || functionName === "recoverNative")) {
      const me = wc.account!.address as Address;
      const [asset, amount] =
        functionName === "recoverERC20" ? (args as [Address, bigint]) : [zeroAddress as Address, 0n];
      return wc.writeContract({
        address: this.addresses.factory,
        abi: ARC_FACTORY_ABI,
        functionName: "emergencyRecover",
        args: [asset, amount, me],
        chain: wc.chain,
        account: wc.account!,
      });
    }
    return wc.writeContract({
      address: this.addresses.factory,
      abi: FACTORY_ABI,
      functionName,
      args: args as never,
      chain: wc.chain,
      account: wc.account!,
    });
  }

  // -- V4-only surface, degraded gracefully -----------------------------

  async tokenExtra(): Promise<null> { return null; }
  /** USD market cap per whole-unit price, same contract as the V4 client:
   *  mcap = (priceWei/1e18) × scale. Supply is 1e9 whole tokens at $1 USDT0. */
  async mcapScale(): Promise<number> {
    // Ensure the quote's USD price is loaded (kicked off by loadCores).
    await this.loadCores().catch(() => {});
    return 1e9 * this.quoteUsd;
  }
  async harvest(): Promise<never> { throw new Error("Not available on Stable."); }
  async claimDividends(): Promise<never> { throw new Error("Not available on Stable."); }

  // -- live updates ------------------------------------------------------

  /** One watcher per token while anything on the page listens: each 4s tick is
   *  a getBlockNumber, an incremental getLogs over just the new blocks, and a
   *  slot0 read; cheap enough to run continuously against the public RPC. */
  private ensureWatcher(key: string) {
    let w = this.watchers.get(key);
    if (!w) {
      w = {
        // 12s per-token poll (was 4s): through the Tor RPC the 4s cadence made
        // the site very chatty (~50 req/user/min). 12s still feels live and
        // cuts per-user RPC load roughly threefold.
        timer: setInterval(() => void this.pollToken(key), 12_000),
        lastBlock: 0n,
        busy: false,
        tradeCbs: new Set(),
        priceCbs: new Set(),
      };
      this.watchers.set(key, w);
      this.loadCores()
        .then(() => this.pollToken(key))
        .catch(() => {});
    }
    return w;
  }

  private stopWatcherIfIdle(key: string) {
    const w = this.watchers.get(key);
    if (w && w.tradeCbs.size === 0 && w.priceCbs.size === 0) {
      clearInterval(w.timer);
      this.watchers.delete(key);
    }
  }

  private async pollToken(key: string) {
    const w = this.watchers.get(key);
    const core = this.cores.get(key);
    if (!w || !core || w.busy) return;
    w.busy = true;
    try {
      const head = await this.publicClient.getBlockNumber();
      let fresh: TradeRecord[] = [];
      if (w.lastBlock === 0n) {
        w.lastBlock = head; // baseline; history came from the initial scan
      } else if (head > w.lastBlock) {
        const W = BigInt(LOGS_WINDOW);
        const from = head - w.lastBlock > W - 1n ? head - W + 1n : w.lastBlock + 1n;
        const logs = await this.poolSwapLogs(core.pool, from, head).catch(() => []);
        // In receipts mode results are only complete up to the walk's height;
        // don't advance past it or late-scanned blocks would be skipped.
        w.lastBlock = this.logsParked() && this.receiptUpTo < head ? (this.receiptUpTo > w.lastBlock ? this.receiptUpTo : w.lastBlock) : head;
        const nowTs = Math.floor(Date.now() / 1000);
        const entry = this.tradesCache.get(key) ?? this.loadPersistedTrades(key) ?? { at: 0, trades: [] };
        const seen = new Set(entry.trades.map((t) => t.id));
        fresh = logs
          .map((l) => this.logToTrade(core, l, head, nowTs))
          .filter((t) => !seen.has(t.id))
          .sort((a, b) => a.blockNumber - b.blockNumber);
        if (fresh.length) {
          entry.trades = [...fresh].reverse().concat(entry.trades).slice(0, 500);
        }
        // Mark the cache fresh either way; the chart's poll reads through
        // getCandles/getTrades and should trust this verified-current data.
        entry.at = Date.now();
        this.tradesCache.set(key, entry);
        this.persistTrades(key, entry);
        for (const t of fresh) for (const cb of w.tradeCbs) cb(t);
      } else {
        const entry = this.tradesCache.get(key);
        if (entry) entry.at = Date.now();
      }
      if (fresh.length) {
        this.holdersCache.delete(key);
        await this.refreshHolders(core).catch(() => {});
      }
      if (w.priceCbs.size > 0) {
        this.priceCache.delete(key);
        const price = await this.priceWei(core).catch(() => null);
        if (price !== null) {
          const update = this.buildPriceUpdate(core, price);
          for (const cb of w.priceCbs) cb(update);
        }
      }
    } finally {
      w.busy = false;
    }
  }

  private buildPriceUpdate(core: Core, price: bigint): PriceUpdate {
    const key = core.address.toLowerCase();
    const supply = 1_000_000_000n * 10n ** 18n;
    const mcapWei = (price * supply) / 10n ** 18n;
    const stats = this.statsFromCache(key);
    return {
      token: core.address,
      priceWei: price.toString(),
      priceUsd: String((Number(price) / 1e18) * this.quoteUsd),
      marketCapUsd: String((Number(mcapWei) / 1e18) * this.quoteUsd),
      liquidityWei: "0",
      limitsActive: false,
      remainingToGraduationUsd: "0",
      creatorFeesWei: "0",
      volume24hWei: stats.vol24.toString(),
      volumeTotalWei: stats.volTotal.toString(),
      txCount24h: stats.tx24,
      ...(stats.holders !== undefined ? { holderCount: stats.holders } : {}),
    };
  }

  subscribeToCandles(): () => void { return () => {}; }

  subscribeToTrades(token: string, cb: (t: TradeRecord) => void): () => void {
    const key = token.toLowerCase();
    const w = this.ensureWatcher(key);
    w.tradeCbs.add(cb);
    return () => {
      w.tradeCbs.delete(cb);
      this.stopWatcherIfIdle(key);
    };
  }

  subscribeToPrice(token: string, cb: (u: PriceUpdate) => void): () => void {
    const key = token.toLowerCase();
    const w = this.ensureWatcher(key);
    w.priceCbs.add(cb);
    return () => {
      w.priceCbs.delete(cb);
      this.stopWatcherIfIdle(key);
    };
  }

  subscribeToLaunches(): () => void { return () => {}; }
}
