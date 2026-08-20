import {
  type Address,
  type PublicClient,
  type WalletClient,
  decodeEventLog,
  parseEther,
  toEventSelector,
} from "viem";
import type { Candle, CandleInterval, HolderRecord, TokenSummary, TradeRecord } from "@launchpad/sdk";
import { INTERVAL_SECONDS } from "@launchpad/sdk";

import { baseFactoryLaunchAbi, erc20Abi, factoryAbi, hookAbi, poolInitEvent, poolSwapEvent, routerAbi, stateViewAbi, stockTradeRouterAbi, tokenAbi } from "./abis";
import { pairUsd, resolvePairRoute } from "./routes";
import { baseStockUsd, resolveBaseRoute } from "../base/routes";

const Q96 = 2n ** 96n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

// Minimal ERC-20 surface for wallet balances and transfers.
const erc20MiniAbi = [
  { type: "function", name: "balanceOf", stateMutability: "view", inputs: [{ type: "address" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "transfer", stateMutability: "nonpayable", inputs: [{ type: "address" }, { type: "uint256" }], outputs: [{ type: "bool" }] },
] as const;

const SWAP_TOPIC = toEventSelector(poolSwapEvent as any);
// Receipt-scanner window: how far back the first scan reaches, and the most
// blocks any single catch-up will walk (Arc blocks are ~0.5s).
const RECEIPT_BACKFILL = 900n;
const RECEIPT_MAX_CATCHUP = 900n;
const RECEIPT_CHUNK = 25;

export interface V4Addresses {
  factory: Address;
  hook: Address;
  router: Address;
  poolManager: Address;
  weth: Address;
  usdg: Address;
  /** Uniswap V4 StateView; enables pool-price reads when logs are unavailable. */
  stateView?: Address;
}

interface Core {
  address: Address;
  creator: Address;
  stock: Address;
  taxBps: number;
  poolId: `0x${string}`;
  launchBlock: bigint;
  createdAt: number;
  name: string;
  symbol: string;
  totalSupply: bigint;
  metadata: Record<string, unknown>;
  tokenIsCurrency0: boolean;
}

/**
 * Backend-free client for the Quiver V4 launchpad. Reads tokens, prices,
 * trades and dividends straight from the factory, the V4 PoolManager and the
 * hook; trades and launches go through the router/factory. Shaped to match the
 * v3 SDK client so the existing hooks and pages use it unchanged.
 */
export class RhClient {
  readonly addresses: { factory: Address; tokenDeployer: Address; weth: Address };
  readonly v4: V4Addresses;
  readonly publicClient: PublicClient;
  private walletClient?: WalletClient;
  private startBlock: bigint;

  private cores = new Map<string, Core>();
  private coresUpTo = 0n;
  private coresInflight: Promise<Core[]> | null = null;
  // Per-pair USD price cache (stock/meme dollar price), refreshed lazily.
  private pairUsdCache = new Map<string, number>();
  // Per-token trade log, kept incrementally: `upTo` is the last block scanned,
  // so each call fetches only new swaps and appends. Never a permanent snapshot
  // (a stale cache is what pinned mcap to the launch price and hid new trades).
  private tradesCache = new Map<string, { records: TradeRecord[]; upTo: bigint }>();
  private blockTsAnchor?: { block: bigint; ts: number; perBlock: number };
  // Shared receipt scanner, the swap-log source when eth_getLogs is disabled:
  // one incremental walk over new blocks feeds every pool's trade feed.
  private receiptUpTo = 0n;
  private receiptLogsByPool = new Map<string, any[]>();
  private receiptInflight: Promise<void> | null = null;

  // Base-stock mode: coins are native B-20 tokens that pair a chosen tokenized
  // stock (not WETH) and pay holders that stock through a per-coin reward vault.
  // B-20 tokens carry no on-chain metadataURI, so metadata is read from the
  // factory's registry, and launches keep the creator-chosen pair + tax.
  private readonly baseStock: boolean;

  constructor(publicClient: PublicClient, v4: V4Addresses, startBlock: bigint, opts?: { baseStock?: boolean }) {
    this.publicClient = publicClient;
    this.v4 = v4;
    this.startBlock = startBlock;
    this.baseStock = opts?.baseStock ?? false;
    this.addresses = { factory: v4.factory, tokenDeployer: v4.factory, weth: v4.weth };
  }

  /** Where a coin's launch metadata (logo, description, links) lives: on the
   *  token itself for the Robinhood fork, in the factory registry for Base
   *  B-20 coins that have no metadataURI of their own. */
  private metaCall(token: Address) {
    return this.baseStock
      ? { address: this.v4.factory, abi: factoryAbi as any, functionName: "metadataURIOf", args: [token] }
      : { address: token, abi: tokenAbi as any, functionName: "metadataURI" };
  }

  connectWallet(wc: WalletClient) {
    this.walletClient = wc;
  }
  private requireWallet(): WalletClient {
    if (!this.walletClient) throw new Error("No wallet connected.");
    return this.walletClient;
  }
  private account(): Address {
    const a = this.walletClient?.account?.address;
    if (!a) throw new Error("No wallet connected.");
    return a;
  }

  // ---------------------------------------------------------------------
  // Discovery
  // ---------------------------------------------------------------------

  private async loadCores(): Promise<Core[]> {
    if (this.coresInflight) return this.coresInflight;
    this.coresInflight = this.loadCoresInner().finally(() => (this.coresInflight = null));
    return this.coresInflight;
  }

  private async loadCoresInner(): Promise<Core[]> {
    let latest: bigint;
    try {
      latest = await this.publicClient.getBlockNumber();
    } catch {
      return [...this.cores.values()];
    }
    if (this.coresUpTo !== 0n && latest <= this.coresUpTo) return [...this.cores.values()];
    // Some Arc RPCs ship with eth_getLogs disabled; the factory's own listings
    // expose the same data through plain view calls, so skip the doomed (and
    // slow, retried) log scan entirely while the method is parked.
    if (Date.now() < this.logsBrokenUntil) return this.loadCoresFromViews(latest);
    let logs: any[];
    try {
      logs = (await this.publicClient.getLogs({
        address: this.v4.factory,
        event: factoryAbi[0] as any,
        fromBlock: this.coresUpTo === 0n ? this.startBlock : this.coresUpTo + 1n,
        toBlock: latest,
      })) as any[];
    } catch {
      this.parkLogs();
      return this.loadCoresFromViews(latest);
    }

    for (const log of logs) {
      const token = (log.args.token as string).toLowerCase() as Address;
      if (this.cores.has(token)) continue;
      try {
        const [name, symbol, supply, metaURI] = (await this.publicClient.multicall({
          allowFailure: false,
          contracts: [
            { address: token, abi: tokenAbi, functionName: "name" },
            { address: token, abi: tokenAbi, functionName: "symbol" },
            { address: token, abi: tokenAbi, functionName: "totalSupply" },
            this.metaCall(token),
          ],
        })) as [string, string, bigint, string];
        let metadata: Record<string, unknown> = {};
        try {
          metadata = JSON.parse(metaURI);
        } catch {
          metadata = { description: metaURI };
        }
        this.cores.set(token, {
          address: token,
          creator: (log.args.creator as string).toLowerCase() as Address,
          stock: (log.args.pair as string).toLowerCase() as Address,
          taxBps: Number(log.args.taxBps),
          poolId: log.args.poolId as `0x${string}`,
          launchBlock: log.blockNumber as bigint,
          createdAt: await this.estTs(log.blockNumber as bigint, latest),
          name,
          symbol,
          totalSupply: supply,
          metadata,
          // The coin pairs against its chosen token; orientation follows that.
          tokenIsCurrency0: BigInt(token) < BigInt(log.args.pair as string),
        });
      } catch {
        // Skip a token that can't be read this pass; picked up next refresh.
      }
    }
    this.coresUpTo = latest;
    return [...this.cores.values()];
  }

  /** Log-free discovery: enumerate the factory's `allTokens`/`listings` views.
   *  Same data as the Launched event except the launch block, which only seeds
   *  the trades scan and safely falls back to the deployment start block. */
  private async loadCoresFromViews(latest: bigint): Promise<Core[]> {
    try {
      const total = Number(
        (await this.publicClient.readContract({
          address: this.v4.factory,
          abi: factoryAbi,
          functionName: "totalTokens",
        })) as bigint,
      );
      if (total <= this.cores.size) {
        this.coresUpTo = latest;
        return [...this.cores.values()];
      }
      const addrs = (await this.publicClient.multicall({
        allowFailure: false,
        contracts: Array.from({ length: total }, (_, i) => ({
          address: this.v4.factory,
          abi: factoryAbi as any,
          functionName: "allTokens",
          args: [BigInt(i)],
        })),
      })) as Address[];
      for (const raw of addrs) {
        const token = raw.toLowerCase() as Address;
        if (this.cores.has(token)) continue;
        try {
          const [listing, name, symbol, supply, metaURI] = (await this.publicClient.multicall({
            allowFailure: false,
            contracts: [
              { address: this.v4.factory, abi: factoryAbi, functionName: "listings", args: [token] },
              { address: token, abi: tokenAbi, functionName: "name" },
              { address: token, abi: tokenAbi, functionName: "symbol" },
              { address: token, abi: tokenAbi, functionName: "totalSupply" },
              this.metaCall(token),
            ],
          })) as [[Address, Address, number, bigint, `0x${string}`], string, string, bigint, string];
          let metadata: Record<string, unknown> = {};
          try {
            metadata = JSON.parse(metaURI);
          } catch {
            metadata = { description: metaURI };
          }
          this.cores.set(token, {
            address: token,
            creator: listing[0].toLowerCase() as Address,
            stock: listing[1].toLowerCase() as Address,
            taxBps: Number(listing[2]),
            poolId: listing[4],
            launchBlock: this.startBlock,
            createdAt: Number(listing[3]),
            name,
            symbol,
            totalSupply: supply,
            metadata,
            tokenIsCurrency0: BigInt(token) < BigInt(listing[1]),
          });
        } catch {
          // Skip a token that can't be read this pass; picked up next refresh.
        }
      }
      this.coresUpTo = latest;
    } catch {
      // Keep whatever we already have; retried on the next refresh.
    }
    return [...this.cores.values()];
  }

  private async estTs(block: bigint, latest: bigint): Promise<number> {
    if (!this.blockTsAnchor || this.blockTsAnchor.block !== latest) {
      try {
        const b = await this.publicClient.getBlock({ blockNumber: latest });
        const prev = await this.publicClient.getBlock({ blockNumber: latest - 5000n < 0n ? 0n : latest - 5000n });
        const perBlock = (Number(b.timestamp) - Number(prev.timestamp)) / (Number(latest - (latest - 5000n)) || 1);
        this.blockTsAnchor = { block: latest, ts: Number(b.timestamp), perBlock: perBlock || 0.25 };
      } catch {
        this.blockTsAnchor = { block: latest, ts: Math.floor(Date.now() / 1000), perBlock: 0.25 };
      }
    }
    const a = this.blockTsAnchor;
    return Math.round(a.ts - Number(latest - block) * a.perBlock);
  }

  // ---------------------------------------------------------------------
  // Pricing + trades
  // ---------------------------------------------------------------------

  /** WETH wei per whole token from a pool sqrtPriceX96. */
  private priceWeiFromSqrt(sqrtP: bigint, tokenIsCurrency0: boolean): bigint {
    if (sqrtP === 0n) return 0n;
    // price(token1/token0) = (sqrtP/2^96)^2. WETH-per-token depends on which
    // side the token is on.
    return tokenIsCurrency0
      ? (sqrtP * sqrtP * 10n ** 18n) / (Q96 * Q96) // token=0, weth=1 -> weth/token = price
      : (Q96 * Q96 * 10n ** 18n) / (sqrtP * sqrtP); // token=1 -> weth/token = 1/price
  }

  /** Per-token inflight guard: the chart, trades list and summary all read
   *  trades concurrently, and two overlapping incremental scans would append
   *  the same logs twice. */
  private tradesInflight = new Map<string, Promise<TradeRecord[]>>();

  private loadTrades(token: Address): Promise<TradeRecord[]> {
    const key = token.toLowerCase();
    const inflight = this.tradesInflight.get(key);
    if (inflight) return inflight;
    const p = this.loadTradesInner(token).finally(() => this.tradesInflight.delete(key));
    this.tradesInflight.set(key, p);
    return p;
  }

  private async loadTradesInner(token: Address): Promise<TradeRecord[]> {
    // Ensure the token's core is loaded; a caller may reach trades/candles
    // without having listed tokens first (e.g. a serverless endpoint hit cold,
    // or a deep link straight to a token page).
    await this.loadCores();
    const key = token.toLowerCase();
    const core = this.cores.get(key);
    if (!core) return [];
    const cached = this.tradesCache.get(key);
    try {
      const latest = await this.publicClient.getBlockNumber();
      // Only scan blocks we haven't seen yet, then append; keeps every read
      // cheap while staying live. First read starts at the launch block.
      const fromBlock = cached ? cached.upTo + 1n : core.launchBlock;
      if (cached && fromBlock > latest) return cached.records;
      const { logs, upTo } = await this.swapLogs(core, fromBlock, latest);
      const fresh: TradeRecord[] = logs.map((log) => {
        const amount0 = log.args.amount0 as bigint;
        const amount1 = log.args.amount1 as bigint;
        const wethDelta = core.tokenIsCurrency0 ? amount1 : amount0; // swapper's WETH delta
        const tokenDelta = core.tokenIsCurrency0 ? amount0 : amount1;
        const isBuy = tokenDelta > 0n; // swapper receives token
        const abs = (v: bigint) => (v < 0n ? -v : v);
        return {
          id: `${log.transactionHash}-${log.logIndex}`,
          token: core.address,
          trader: (log.args.sender as string).toLowerCase() as Address,
          isBuy,
          nativeAmountWei: abs(wethDelta).toString(),
          tokenAmount: abs(tokenDelta).toString(),
          feeWei: ((abs(wethDelta) * BigInt(core.taxBps)) / 10_000n).toString(),
          priceWei: this.priceWeiFromSqrt(log.args.sqrtPriceX96 as bigint, core.tokenIsCurrency0).toString(),
          blockNumber: Number(log.blockNumber),
          txHash: log.transactionHash,
          timestamp: 0,
        };
      });
      // Estimate timestamps from block numbers.
      if (fresh.length) {
        for (const r of fresh) r.timestamp = await this.estTs(BigInt(r.blockNumber), latest);
      }
      // The Swap event's sender is our router for every trade; resolve the
      // real wallet from each transaction's `from` so holder stats and the
      // trades feed attribute activity to actual traders.
      if (fresh.length) {
        const hashes = [...new Set(fresh.map((r) => r.txHash))];
        const txs = await Promise.allSettled(
          hashes.map((h) => this.publicClient.getTransaction({ hash: h as `0x${string}` })),
        );
        const fromByHash = new Map<string, Address>();
        txs.forEach((r, i) => {
          if (r.status === "fulfilled" && r.value?.from) fromByHash.set(hashes[i], r.value.from.toLowerCase() as Address);
        });
        for (const r of fresh) r.trader = fromByHash.get(r.txHash) ?? r.trader;
      }
      // Merge by id (txHash-logIndex): a log source may re-serve blocks near
      // the boundary, and a duplicate row must never reach the feed.
      let records: TradeRecord[];
      if (cached) {
        const seen = new Set(cached.records.map((r) => r.id));
        records = cached.records.concat(fresh.filter((r) => !seen.has(r.id)));
      } else {
        records = fresh;
      }
      // `upTo` is the height the log source is actually complete to (behind
      // `latest` while the receipt scanner backfills), so nothing is skipped.
      // Never let it regress (e.g. getLogs -> receipt-scan fallback), or the
      // next pass would re-fetch blocks it already served.
      this.tradesCache.set(key, { records, upTo: cached && cached.upTo > upTo ? cached.upTo : upTo });
      return records;
    } catch {
      return this.tradesCache.get(key)?.records ?? [];
    }
  }

  /** While set (epoch ms), eth_getLogs is considered broken on this RPC and
   *  every consumer goes straight to view/receipt fallbacks. A single failed
   *  probe (a rate-limit hiccup under launch traffic) used to park logs for
   *  five minutes AND persist that across reloads, which blanked charts,
   *  trades, and holders for everyone affected; now a park is short-lived,
   *  memory-only, and any stale persisted marker is cleared on startup. */
  private logsBrokenUntil = (() => {
    try {
      globalThis.localStorage?.removeItem("lp.logsBrokenUntil");
    } catch {
      /* private mode */
    }
    return 0;
  })();
  private parkLogs() {
    this.logsBrokenUntil = Date.now() + 45_000;
  }

  /** Swap logs for one pool with the block height the result is complete up
   *  to. Prefers eth_getLogs; when the RPC has it disabled, serves whatever
   *  the shared receipt scanner has ingested so far and refreshes it in the
   *  background; list paints never wait on a block walk. */
  private async swapLogs(
    core: Core,
    fromBlock: bigint,
    latest: bigint,
  ): Promise<{ logs: any[]; upTo: bigint }> {
    if (Date.now() >= this.logsBrokenUntil) {
      try {
        const logs = (await this.publicClient.getLogs({
          address: this.v4.poolManager,
          event: poolSwapEvent as any,
          args: { id: core.poolId },
          fromBlock,
          toBlock: latest,
        })) as any[];
        return { logs, upTo: latest };
      } catch {
        this.parkLogs();
      }
    }
    void this.scanReceiptsTo(latest).catch(() => undefined);
    const upTo = this.receiptUpTo;
    const logs = (this.receiptLogsByPool.get(core.poolId) ?? [])
      .filter((lg) => BigInt(lg.blockNumber) >= fromBlock && BigInt(lg.blockNumber) <= upTo)
      .map((lg) => {
        const d = decodeEventLog({ abi: [poolSwapEvent] as any, data: lg.data, topics: lg.topics }) as any;
        return {
          args: d.args,
          blockNumber: BigInt(lg.blockNumber),
          transactionHash: lg.transactionHash,
          logIndex: Number(lg.logIndex),
        };
      });
    return { logs, upTo };
  }

  /** Walk block receipts from the last scanned block to `latest` and collect
   *  PoolManager Swap logs per pool. Shared across all tokens; each block is
   *  fetched once no matter how many pools are on screen. */
  private async scanReceiptsTo(latest: bigint): Promise<void> {
    while (this.receiptInflight) await this.receiptInflight;
    if (this.receiptUpTo >= latest) return;
    this.receiptInflight = (async () => {
      let from = this.receiptUpTo === 0n ? latest - RECEIPT_BACKFILL : this.receiptUpTo + 1n;
      if (from < 1n) from = 1n;
      if (latest - from > RECEIPT_MAX_CATCHUP) from = latest - RECEIPT_MAX_CATCHUP;
      const blocks: bigint[] = [];
      for (let b = from; b <= latest; b++) blocks.push(b);
      const pm = this.v4.poolManager.toLowerCase();
      for (let i = 0; i < blocks.length; i += RECEIPT_CHUNK) {
        const chunk = blocks.slice(i, i + RECEIPT_CHUNK);
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
              if ((lg.address ?? "").toLowerCase() !== pm) continue;
              if (lg.topics?.[0] !== SWAP_TOPIC || !lg.topics[1]) continue;
              const arr = this.receiptLogsByPool.get(lg.topics[1]) ?? [];
              arr.push(lg);
              this.receiptLogsByPool.set(lg.topics[1], arr);
            }
          }
        }
      }
      this.receiptUpTo = latest;
    })().finally(() => (this.receiptInflight = null));
    await this.receiptInflight;
  }

  private initPriceCache = new Map<string, bigint>();
  /** Initial pool price (WETH wei per token) from the Initialize event, used
   *  before a token has any trades so it shows its true starting market cap. */
  private async initPrice(core: Core): Promise<bigint> {
    const hit = this.initPriceCache.get(core.address);
    if (hit !== undefined) return hit;
    try {
      const logs = (await this.publicClient.getLogs({
        address: this.v4.poolManager,
        event: poolInitEvent as any,
        args: { id: core.poolId },
        fromBlock: core.launchBlock,
        toBlock: core.launchBlock,
      })) as any[];
      const sqrtP = logs.length ? (logs[0].args.sqrtPriceX96 as bigint) : 0n;
      const price = this.priceWeiFromSqrt(sqrtP, core.tokenIsCurrency0);
      this.initPriceCache.set(core.address, price);
      return price;
    } catch {
      return 0n;
    }
  }

  /** Current pool price straight from slot0 (StateView), so tokens keep a real
   *  price and market cap even when swap logs are unavailable. */
  private async poolPriceNow(core: Core): Promise<bigint> {
    if (this.v4.stateView) {
      try {
        const [sqrtP] = (await this.publicClient.readContract({
          address: this.v4.stateView,
          abi: stateViewAbi,
          functionName: "getSlot0",
          args: [core.poolId],
        })) as [bigint, number, number, number];
        if (sqrtP !== 0n) return this.priceWeiFromSqrt(sqrtP, core.tokenIsCurrency0);
      } catch {
        /* fall through to the Initialize-event price */
      }
    }
    return this.initPrice(core);
  }

  /** USD price of a coin's pair token (stock/meme), cached in-memory and
   *  refreshed opportunistically in the background. */
  private async pairUsdOf(pair: Address): Promise<number> {
    const key = pair.toLowerCase();
    // Base stocks price off the curated snapshot (also what sizes the launch);
    // the Robinhood-chain Blockscout price source does not cover Base.
    if (this.baseStock) {
      const u = baseStockUsd(pair);
      this.pairUsdCache.set(key, u);
      return u;
    }
    const cached = this.pairUsdCache.get(key);
    // Kick a background refresh; return the cached value immediately if present.
    const refresh = pairUsd(pair, this.publicClient)
      .then((v) => {
        if (v > 0) this.pairUsdCache.set(key, v);
        return v;
      })
      .catch(() => cached ?? 0);
    return cached ?? (await refresh);
  }

  private async summarize(core: Core): Promise<TokenSummary & { priceEthWei: string }> {
    // Surface the reward stock on the metadata so lists can badge it without a
    // second read (the shared TokenSummary type has no dedicated field).
    if (core.metadata && (core.metadata as any).rewardStock === undefined) {
      (core.metadata as any).rewardStock = core.stock;
    }
    const trades = await this.loadTrades(core.address);
    const last = trades[trades.length - 1];
    const priceWei = last ? BigInt(last.priceWei) : await this.poolPriceNow(core);
    // priceWei is pair-token units per whole coin (pair is 18 decimals). USD
    // value comes from the pair token's own dollar price.
    const pricePairPerToken = Number(priceWei) / 1e18;
    const supplyWhole = Number(core.totalSupply) / 1e18;
    const usd = await this.pairUsdOf(core.stock);
    const priceUsdPerToken = pricePairPerToken * usd;
    // A coin seeds at the STARTING_MCAP; if the pool price can't be read yet
    // (a brand-new launch with no trades), fall back to that so it never shows
    // a zero market cap before its first buy.
    const STARTING_MCAP = 4000;
    const computed = priceUsdPerToken * supplyWhole;
    const mcapUsd = computed > 0 ? computed : (trades.length === 0 ? STARTING_MCAP : 0);
    // ETH-per-coin equivalent for the trade ticket: buys pay ETH and sells
    // receive ETH (the router auto-routes through the pair), so quotes and
    // minOut must be in native units, not pair units.
    const ethUsd = core.stock.toLowerCase() === this.v4.weth.toLowerCase() ? usd : await this.pairUsdOf(this.v4.weth);
    const priceEthPerToken = usd > 0 && ethUsd > 0 ? (pricePairPerToken * usd) / ethUsd : 0;

    const dayAgo = Math.floor(Date.now() / 1000) - 86400;
    const dayTrades = trades.filter((t) => t.timestamp >= dayAgo);
    const vol24 = dayTrades.reduce((a, t) => a + BigInt(t.nativeAmountWei), 0n);
    const volTotal = trades.reduce((a, t) => a + BigInt(t.nativeAmountWei), 0n);
    const ref = [...trades].reverse().find((t) => t.timestamp <= dayAgo);
    const lastP = last ? Number(last.priceWei) : 0;
    const refP = ref ? Number(ref.priceWei) : trades[0] ? Number(trades[0].priceWei) : 0;
    const change = lastP > 0 && refP > 0 && trades.length > 1 ? ((lastP - refP) / refP) * 100 : null;
    const holders = new Set(trades.map((t) => t.trader));

    // WETH in pool ~ liquidity proxy (best-effort read).
    let wethInPool = 0n;
    try {
      wethInPool = (await this.publicClient.readContract({
        address: this.v4.weth,
        abi: erc20Abi,
        functionName: "balanceOf",
        args: [this.v4.poolManager],
      })) as bigint;
    } catch {
      /* ignore */
    }

    return {
      address: core.address,
      name: core.name,
      symbol: core.symbol,
      creator: core.creator,
      pool: this.v4.poolManager,
      feeTier: core.taxBps,
      createdAt: core.createdAt,
      featured: false,
      metadata: core.metadata as any,
      totalSupply: core.totalSupply.toString(),
      priceWei: priceWei.toString(),
      priceUsd: String(priceUsdPerToken),
      // Native-denominated price (wei per whole coin) for buy/sell estimates.
      priceEthWei: BigInt(Math.round(priceEthPerToken * 1e18)).toString(),
      // Plain-dollar string, matching the SDK's usd8() convention (fmtUsd expects dollars).
      marketCapUsd: String(mcapUsd),
      liquidityWei: wethInPool.toString(),
      volume24hWei: vol24.toString(),
      volumeTotalWei: volTotal.toString(),
      txCount24h: dayTrades.length,
      holderCount: holders.size,
      limitsActive: true,
      remainingToGraduationUsd: "0",
      priceChange24hPct: change,
    };
  }

  // ---------------------------------------------------------------------
  // Reads (client interface)
  // ---------------------------------------------------------------------

  async getTokens(opts?: { sort?: "new" | "volume" | "marketCap" | "featured"; limit?: number }): Promise<TokenSummary[]> {
    const cores = await this.loadCores();
    const settled = await Promise.allSettled(cores.map((c) => this.summarize(c)));
    const list = settled
      .filter((r): r is PromiseFulfilledResult<TokenSummary & { priceEthWei: string }> => r.status === "fulfilled")
      .map((r) => r.value);
    const sort = opts?.sort ?? "new";
    if (sort === "volume") list.sort((a, b) => Number(b.volume24hWei) - Number(a.volume24hWei));
    else if (sort === "marketCap") list.sort((a, b) => Number(b.marketCapUsd) - Number(a.marketCapUsd));
    else list.sort((a, b) => b.createdAt - a.createdAt);
    return list.slice(0, opts?.limit ?? 50);
  }

  async getToken(token: Address): Promise<TokenSummary> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    if (!core) throw new Error("token not found");
    return this.summarize(core);
  }

  async getTrades(token: Address, opts?: { limit?: number }): Promise<TradeRecord[]> {
    const trades = await this.loadTrades(token);
    return [...trades].reverse().slice(0, opts?.limit ?? 50);
  }

  async getCandles(token: Address, interval: CandleInterval, opts?: { limit?: number }): Promise<Candle[]> {
    const trades = await this.loadTrades(token);
    const span = INTERVAL_SECONDS[interval];
    const buckets = new Map<number, Candle>();
    for (const t of trades) {
      const bucket = Math.floor(t.timestamp / span) * span;
      const price = Number(t.priceWei) / 1e18;
      const vol = Number(t.nativeAmountWei) / 1e18;
      const c = buckets.get(bucket);
      if (!c) {
        buckets.set(bucket, {
          time: bucket,
          open: String(price),
          high: String(price),
          low: String(price),
          close: String(price),
          volume: String(vol),
        });
      } else {
        c.high = String(Math.max(Number(c.high), price));
        c.low = String(Math.min(Number(c.low), price));
        c.close = String(price);
        c.volume = String(Number(c.volume) + vol);
      }
    }
    const arr = [...buckets.values()].sort((a, b) => a.time - b.time);
    const limit = opts?.limit ?? 500;
    if (arr.length === 0) return arr;

    // Fill trade-less intervals with flat candles so a young coin renders a
    // continuous tape instead of a few isolated dashes, and stitch each
    // candle's open to the previous close.
    // End at the later of device-now and the newest candle: chain timestamps
    // can run ahead of the device clock, and clamping to device-now would
    // drop that candle and blank the chart.
    const now = Math.max(
      Math.floor(Date.now() / 1000 / span) * span,
      arr[arr.length - 1].time,
    );
    const start = Math.max(arr[0].time, now - span * (limit - 1));
    let prevClose = arr[0].open;
    for (const c of arr) {
      if (c.time < start) prevClose = c.close;
      else break;
    }
    const filled: Candle[] = [];
    let i = arr.findIndex((c) => c.time >= start);
    if (i < 0) i = arr.length;
    for (let t = start; t <= now; t += span) {
      const c = i < arr.length && arr[i].time === t ? arr[i++] : null;
      if (c) {
        c.open = prevClose;
        c.high = String(Math.max(Number(c.high), Number(prevClose)));
        c.low = String(Math.min(Number(c.low), Number(prevClose)));
        filled.push(c);
        prevClose = c.close;
      } else {
        filled.push({ time: t, open: prevClose, high: prevClose, low: prevClose, close: prevClose, volume: "0" });
      }
    }
    return filled.slice(-limit);
  }

  async getHolders(token: Address, opts?: { limit?: number }): Promise<HolderRecord[]> {
    const trades = await this.getTrades(token, { limit: 1000 });
    const bal = new Map<string, number>();
    for (const t of trades) {
      const amt = Number(t.tokenAmount) / 1e18;
      bal.set(t.trader, (bal.get(t.trader) ?? 0) + (t.isBuy ? amt : -amt));
    }
    const supply = Number(TOTAL_SUPPLY) / 1e18;
    return [...bal.entries()]
      .filter(([, b]) => b > 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts?.limit ?? 50)
      .map(([address, b]) => ({ address: address as Address, balance: String(Math.round(b * 1e18)), pct: (b / supply) * 100 }));
  }

  // ---------------------------------------------------------------------
  // V4-specific reads
  // ---------------------------------------------------------------------

  async tokenExtra(token: Address): Promise<{ stock: Address; taxBps: number; totalRewards: bigint; creatorFees: bigint }> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    const rewards = (await this.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "totalRewardsDistributed",
    }).catch(() => 0n)) as bigint;
    return {
      // `stock` here is the coin's pair/reward token (a stock or meme).
      stock: core?.stock ?? ("0x0000000000000000000000000000000000000000" as Address),
      taxBps: core?.taxBps ?? 0,
      totalRewards: rewards,
      creatorFees: 0n, // no creator fee in the pair=reward fork
    };
  }

  /** USD market cap per unit of pair-per-token price (for the chart axis). */
  async mcapScale(token: Address): Promise<number> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    const supplyWhole = core ? Number(core.totalSupply) / 1e18 : 1e9;
    const usd = core ? await this.pairUsdOf(core.stock) : 0;
    const scale = usd * supplyWhole;
    // 0 (not 1) when the pair has no USD price, so consumers render a dash
    // instead of passing raw pair-units off as dollars.
    return scale > 0 ? scale : 0;
  }

  /** Un-harvested base trade fees still sitting in the hook for this coin:
   *  a coin-denominated bucket and an ETH (pair) bucket. The creator's 80%
   *  comes out of these; the sniper premium is tracked separately and goes
   *  to the bid wall, so it is deliberately excluded here. */
  async pendingFees(token: Address): Promise<{ coin: bigint; pair: bigint }> {
    const [coin, pair] = (await Promise.all([
      this.publicClient.readContract({ address: this.v4.hook, abi: hookAbi, functionName: "tokenFees", args: [token] }),
      this.publicClient.readContract({ address: this.v4.hook, abi: hookAbi, functionName: "pairFees", args: [token] }),
    ])) as [bigint, bigint];
    return { coin, pair };
  }

  async pendingDividends(token: Address, holder: Address): Promise<bigint> {
    return (await this.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "pendingRewards",
      args: [holder],
    })) as bigint;
  }

  // ---------------------------------------------------------------------
  // Writes
  // ---------------------------------------------------------------------

  /** Resolve the coin's pair token, then its ETH<->pair V3 route. */
  private async routeFor(token: Address): Promise<{ buy: `0x${string}`; sell: `0x${string}` }> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    const pair = (core?.stock ?? this.v4.weth) as Address;
    // Base stocks bridge ETH<->stock through Aerodrome Slipstream; the
    // Robinhood fork uses Uniswap V3. Both feed the same router buy/sell ABI.
    if (this.baseStock) return resolveBaseRoute(pair);
    return resolvePairRoute(this.publicClient, pair);
  }

  // Cache of each coin's pair token info (address, symbol, decimals) for the
  // base-stock pair-denominated trade flow.
  private pairInfoCache = new Map<string, { address: Address; symbol: string; decimals: number }>();

  /** The pair token a base-stock coin trades against (a stock or USDC): its
   *  address, ticker and decimals. Used by the trade panel to size input. */
  async basePairInfo(coin: Address): Promise<{ address: Address; symbol: string; decimals: number }> {
    const key = coin.toLowerCase();
    const hit = this.pairInfoCache.get(key);
    if (hit) return hit;
    await this.loadCores();
    const pair = (this.cores.get(key)?.stock ?? this.v4.weth) as Address;
    let symbol = "TOKEN";
    let decimals = 18;
    try {
      const [s, d] = (await this.publicClient.multicall({
        allowFailure: false,
        contracts: [
          { address: pair, abi: erc20Abi, functionName: "symbol" },
          { address: pair, abi: erc20Abi, functionName: "decimals" },
        ],
      })) as [string, number];
      symbol = s;
      decimals = Number(d);
    } catch {
      /* keep defaults */
    }
    const info = { address: pair, symbol, decimals };
    this.pairInfoCache.set(key, info);
    return info;
  }

  /** Convert a whole-dollar quick-buy amount into the value `buyToken` expects
   *  for this coin: ETH wei for a WETH pair, else the pair token's own units.
   *  Uses the pair's live USD price so $10 buys ~$10 of the pair regardless of
   *  which asset the coin trades against. */
  async quickBuyValue(coin: Address, usd: number): Promise<bigint> {
    const info = await this.basePairInfo(coin);
    const price = await this.pairUsdOf(info.address);
    if (!(price > 0)) throw new Error("This pool has no price yet — open it to trade.");
    const units = (usd / price) * 10 ** info.decimals;
    if (!(units > 0)) throw new Error("Amount too small for this pool.");
    return BigInt(Math.floor(units));
  }

  /** Approve `spender` to pull `amount` of `erc` from the caller if the current
   *  allowance is short. Waits for the approval to confirm. */
  private async ensureAllowance(erc: Address, spender: Address, amount: bigint) {
    const wc = this.requireWallet();
    const account = this.account();
    const allowance = (await this.publicClient.readContract({
      address: erc,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account, spender],
    })) as bigint;
    if (allowance >= amount) return;
    const hash = await wc.writeContract({
      account,
      chain: wc.chain,
      address: erc,
      abi: tokenAbi,
      functionName: "approve",
      args: [spender, 2n ** 256n - 1n],
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  async buyToken(token: Address, valueWei: bigint, minOut: bigint = 0n): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    // Base stocks: pay with the pair token (USDC/stock) through StockTradeRouter.
    // `valueWei` here is the pay-token amount (ETH wei for a WETH pair, else the
    // pair token's own units).
    if (this.baseStock) {
      const pair = await this.basePairInfo(token);
      // WETH pair -> one-tap native ETH (the router wraps).
      if (pair.address.toLowerCase() === this.v4.weth.toLowerCase()) {
        return wc.writeContract({
          account: this.account(),
          chain: wc.chain,
          address: this.v4.router,
          abi: stockTradeRouterAbi,
          functionName: "buyWithEth",
          args: [token, minOut],
          value: valueWei,
        });
      }
      await this.ensureAllowance(pair.address, this.v4.router, valueWei);
      return wc.writeContract({
        account: this.account(),
        chain: wc.chain,
        address: this.v4.router,
        abi: stockTradeRouterAbi,
        functionName: "buy",
        args: [token, valueWei, minOut],
      });
    }
    const route = await this.routeFor(token);
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: this.v4.router,
      abi: routerAbi,
      functionName: "buy",
      args: [token, route.buy, minOut],
      value: valueWei,
    });
  }

  async sellToken(token: Address, amount: bigint, minOut: bigint = 0n): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    const account = this.account();
    // Base stocks: sell the coin for its pair token through StockTradeRouter.
    // `minOut` is denominated in the pair token (or ETH for a WETH pair).
    if (this.baseStock) {
      const pair = await this.basePairInfo(token);
      await this.ensureAllowance(token, this.v4.router, amount);
      const isWeth = pair.address.toLowerCase() === this.v4.weth.toLowerCase();
      return wc.writeContract({
        account,
        chain: wc.chain,
        address: this.v4.router,
        abi: stockTradeRouterAbi,
        functionName: isWeth ? "sellForEth" : "sell",
        args: [token, amount, minOut],
      });
    }
    const route = await this.routeFor(token);
    const allowance = (await this.publicClient.readContract({
      address: token,
      abi: tokenAbi,
      functionName: "allowance",
      args: [account, this.v4.router],
    })) as bigint;
    if (allowance < amount) {
      const approveHash = await wc.writeContract({
        account,
        chain: wc.chain,
        address: token,
        abi: tokenAbi,
        functionName: "approve",
        args: [this.v4.router, 2n ** 256n - 1n],
      });
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }
    return wc.writeContract({
      account,
      chain: wc.chain,
      address: this.v4.router,
      abi: routerAbi,
      functionName: "sell",
      args: [token, amount, route.sell, minOut],
    });
  }

  /** Balance of an asset for `owner`. Native ETH when `asset` is the zero
   *  address, else the ERC-20 balance. */
  async assetBalance(asset: Address, owner: Address): Promise<bigint> {
    if (asset === "0x0000000000000000000000000000000000000000") {
      return this.publicClient.getBalance({ address: owner });
    }
    return (await this.publicClient.readContract({
      address: asset,
      abi: erc20MiniAbi,
      functionName: "balanceOf",
      args: [owner],
    })) as bigint;
  }

  /** USD price of a fundable asset: ETH (zero address) and WETH price off the
   *  WETH pool; everything else off its own pair price (USDC ≈ 1). */
  async assetUsdPrice(asset: Address): Promise<number> {
    const a = asset === "0x0000000000000000000000000000000000000000" ? this.v4.weth : asset;
    return this.pairUsdOf(a as Address);
  }

  /** Send `amount` of an asset to `to`: a native ETH transfer when `asset` is
   *  the zero address, else an ERC-20 transfer. Non-custodial — the connected
   *  wallet signs. */
  async transferAsset(asset: Address, to: Address, amount: bigint): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    const account = this.account();
    if (asset === "0x0000000000000000000000000000000000000000") {
      return wc.sendTransaction({ account, chain: wc.chain, to, value: amount });
    }
    return wc.writeContract({
      account,
      chain: wc.chain,
      address: asset,
      abi: erc20MiniAbi,
      functionName: "transfer",
      args: [to, amount],
    });
  }

  /** The pair=reward fork has no creator fee; harvest sends 80% to holders and
   *  20% to the platform. Present only so callers that probe for it don't crash. */
  async claimCreatorFees(_token: Address): Promise<`0x${string}`> {
    throw new Error("No creator fees in this launchpad; holders earn the pair token.");
  }

  /** Claim the caller's WETH share of a closed weekly epoch's trader pot. */
  async claimTrader(epoch: bigint): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: this.v4.hook,
      abi: hookAbi,
      functionName: "claimTrader",
      args: [epoch],
    });
  }

  async claimDividends(token: Address): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: token,
      abi: tokenAbi,
      functionName: "claim",
      args: [],
    });
  }

  /** Realize accrued tax into holder stock rewards, creator fees and protocol
   *  (50/25/25). Permissionless; anyone can trigger it for a token. */
  async harvest(token: Address): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: this.v4.hook,
      abi: hookAbi,
      functionName: "harvest",
      args: [token],
    });
  }

  /** Launch a coin. Uses a random CREATE2 salt (addresses are not vanity
   *  mined) and sizes the $3k start from the pair's live USD price. */
  async createToken(params: {
    name: string;
    symbol: string;
    metadataURI?: string;
    stock: Address; // the pair/reward token
    taxBps: number;
    pairUsdPrice8?: bigint; // pair token USD price, 8dp; fetched if omitted
    devBuyWei?: bigint; // optional atomic initial buy, in ETH wei
    burnBps?: number; // base-stock only: creator-share slice that auto-burns
    liquidityBps?: number; // base-stock only: creator-share slice single-sided into LP
  }): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    const creator = this.account();
    // Base-stock model keeps the creator's chosen stock + tax. The Hood model
    // instead forces every coin to pair WETH at a flat 1% fee.
    if (!this.baseStock) params = { ...params, stock: this.v4.weth, taxBps: 100 };
    const metadataURI = params.metadataURI ?? "";
    // Size the start market cap from the pair token's USD price. Never launch on
    // a bad price (it would mis-size the starting market cap), so require > 0.
    let pairUsdPrice8 = params.pairUsdPrice8 ?? 0n;
    if (pairUsdPrice8 <= 0n) {
      const usd = await pairUsd(params.stock, this.publicClient);
      if (!(usd > 0)) throw new Error("Could not read the pair token price. Try again in a moment.");
      pairUsdPrice8 = BigInt(Math.round(usd * 1e8));
    }
    const saltBytes = new Uint8Array(32);
    crypto.getRandomValues(saltBytes);
    const salt = `0x${Array.from(saltBytes, (b) => b.toString(16).padStart(2, "0")).join("")}` as `0x${string}`;

    if (this.baseStock) {
      // StockFlyFactoryV2: the creator share splits 50/50 between the creator
      // and the coin's reward vault. burn/liquidity default off, so the whole
      // creator share is payable and holders earn the maximum stock.
      const burnBps = params.burnBps ?? 0;
      const liquidityBps = params.liquidityBps ?? 0;
      return wc.writeContract({
        account: creator,
        chain: wc.chain,
        address: this.v4.factory,
        abi: baseFactoryLaunchAbi,
        functionName: "launch",
        args: [
          { name: params.name, symbol: params.symbol, metadataURI, pair: params.stock, taxBps: params.taxBps, pairUsdPrice8, burnBps, liquidityBps },
          salt,
        ],
        value: params.devBuyWei ?? 0n,
      });
    }

    return wc.writeContract({
      account: creator,
      chain: wc.chain,
      address: this.v4.factory,
      abi: factoryAbi,
      functionName: "launch",
      args: [
        { name: params.name, symbol: params.symbol, metadataURI, pair: params.stock, taxBps: params.taxBps, pairUsdPrice8 },
        salt,
      ],
      // Atomic dev buy: ETH sent with launch is swapped into the new coin in
      // the same transaction, sniper-tax-exempt, before anyone else can trade.
      value: params.devBuyWei ?? 0n,
    });
  }

  // ---------------------------------------------------------------------
  // Live updates (polling)
  // ---------------------------------------------------------------------

  subscribeToLaunches(cb: () => void): () => void {
    const id = setInterval(() => {
      this.coresUpTo = 0n; // force re-scan
      cb();
    }, 20_000);
    return () => clearInterval(id);
  }
  subscribeToTrades(token: Address, cb: (t: TradeRecord) => void): () => void {
    // Emit each trade exactly once. The first tick seeds the seen-set with
    // whatever the initial getTrades already rendered; later ticks ride the
    // incremental scan (no cache wipe) and surface only genuinely new rows.
    const seen = new Set<string>();
    let seeded = false;
    const tick = () =>
      this.loadTrades(token)
        .then((tr) => {
          if (!seeded) {
            for (const r of tr) seen.add(r.id);
            seeded = true;
            return;
          }
          for (const r of tr) {
            if (!seen.has(r.id)) {
              seen.add(r.id);
              cb(r);
            }
          }
        })
        .catch(() => undefined);
    void tick();
    const id = setInterval(tick, 12_000);
    return () => clearInterval(id);
  }
  subscribeToPrice(_token: Address, _cb: (u: unknown) => void): () => void {
    return () => undefined;
  }
  subscribeToCandles(token: Address, interval: CandleInterval, cb: (u: { candle: Candle }) => void): () => void {
    // The incremental trade scan already picks up new blocks; re-bucketing the
    // last candle is idempotent by time key, so no cache wipe is needed.
    const id = setInterval(() => {
      this.getCandles(token, interval, { limit: 1 }).then((c) => c.length && cb({ candle: c[c.length - 1] })).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }

  close() {}

  // Convenience for parity with the v3 client used by helpers.
  parseEther = parseEther;
}
