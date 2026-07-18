import {
  type Address,
  type PublicClient,
  type WalletClient,
  concatHex,
  encodeAbiParameters,
  getContractAddress,
  keccak256,
  parseEther,
} from "viem";
import type { Candle, CandleInterval, HolderRecord, TokenSummary, TradeRecord } from "@launchpad/sdk";
import { INTERVAL_SECONDS } from "@launchpad/sdk";

import { erc20Abi, factoryAbi, hookAbi, poolInitEvent, poolSwapEvent, routerAbi, tokenAbi } from "./abis";
import { QUIVER_TOKEN_BYTECODE } from "./tokenBytecode";

const Q96 = 2n ** 96n;
const TOTAL_SUPPLY = 1_000_000_000n * 10n ** 18n;

export interface V4Addresses {
  factory: Address;
  hook: Address;
  router: Address;
  poolManager: Address;
  weth: Address;
  usdg: Address;
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
export class V4Client {
  readonly addresses: { factory: Address; tokenDeployer: Address; weth: Address };
  readonly v4: V4Addresses;
  readonly publicClient: PublicClient;
  private walletClient?: WalletClient;
  private startBlock: bigint;

  private cores = new Map<string, Core>();
  private coresUpTo = 0n;
  private coresInflight: Promise<Core[]> | null = null;
  private nativeUsd = 3000; // USD per WETH, refreshed from the factory
  // Per-token trade log, kept incrementally: `upTo` is the last block scanned,
  // so each call fetches only new swaps and appends. Never a permanent snapshot
  // (a stale cache is what pinned mcap to the launch price and hid new trades).
  private tradesCache = new Map<string, { records: TradeRecord[]; upTo: bigint }>();
  private blockTsAnchor?: { block: bigint; ts: number; perBlock: number };

  constructor(publicClient: PublicClient, v4: V4Addresses, startBlock: bigint) {
    this.publicClient = publicClient;
    this.v4 = v4;
    this.startBlock = startBlock;
    this.addresses = { factory: v4.factory, tokenDeployer: v4.factory, weth: v4.weth };
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
    // Refresh the WETH/USD rate opportunistically.
    this.publicClient
      .readContract({ address: this.v4.factory, abi: factoryAbi, functionName: "nativeUsdPrice8" })
      .then((p) => (this.nativeUsd = Number(p) / 1e8 || this.nativeUsd))
      .catch(() => undefined);

    if (this.coresUpTo !== 0n && latest <= this.coresUpTo) return [...this.cores.values()];
    let logs: any[];
    try {
      logs = (await this.publicClient.getLogs({
        address: this.v4.factory,
        event: factoryAbi[0] as any,
        fromBlock: this.coresUpTo === 0n ? this.startBlock : this.coresUpTo + 1n,
        toBlock: latest,
      })) as any[];
    } catch {
      return [...this.cores.values()];
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
            { address: token, abi: tokenAbi, functionName: "metadataURI" },
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
          stock: (log.args.stock as string).toLowerCase() as Address,
          taxBps: Number(log.args.taxBps),
          poolId: log.args.poolId as `0x${string}`,
          launchBlock: log.blockNumber as bigint,
          createdAt: await this.estTs(log.blockNumber as bigint, latest),
          name,
          symbol,
          totalSupply: supply,
          metadata,
          tokenIsCurrency0: BigInt(token) < BigInt(this.v4.weth),
        });
      } catch {
        // Skip a token that can't be read this pass; picked up next refresh.
      }
    }
    this.coresUpTo = latest;
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

  private async loadTrades(token: Address): Promise<TradeRecord[]> {
    // Ensure the token's core is loaded — a caller may reach trades/candles
    // without having listed tokens first (e.g. a serverless endpoint hit cold,
    // or a deep link straight to a token page).
    await this.loadCores();
    const key = token.toLowerCase();
    const core = this.cores.get(key);
    if (!core) return [];
    const cached = this.tradesCache.get(key);
    try {
      const latest = await this.publicClient.getBlockNumber();
      // Only scan blocks we haven't seen yet, then append — keeps every read
      // cheap while staying live. First read starts at the launch block.
      const fromBlock = cached ? cached.upTo + 1n : core.launchBlock;
      if (cached && fromBlock > latest) return cached.records;
      const logs = (await this.publicClient.getLogs({
        address: this.v4.poolManager,
        event: poolSwapEvent as any,
        args: { id: core.poolId },
        fromBlock,
        toBlock: latest,
      })) as any[];
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
      const records = cached ? cached.records.concat(fresh) : fresh;
      this.tradesCache.set(key, { records, upTo: latest });
      return records;
    } catch {
      return this.tradesCache.get(key)?.records ?? [];
    }
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

  private async summarize(core: Core): Promise<TokenSummary> {
    // Surface the reward stock on the metadata so lists can badge it without a
    // second read (the shared TokenSummary type has no dedicated field).
    if (core.metadata && (core.metadata as any).rewardStock === undefined) {
      (core.metadata as any).rewardStock = core.stock;
    }
    const trades = await this.loadTrades(core.address);
    const last = trades[trades.length - 1];
    const priceWei = last ? BigInt(last.priceWei) : await this.initPrice(core);
    const priceWethPerToken = Number(priceWei) / 1e18;
    const supplyWhole = Number(core.totalSupply) / 1e18;
    const mcapUsd = priceWethPerToken * supplyWhole * this.nativeUsd;

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
      priceUsd: String(priceWethPerToken * this.nativeUsd),
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
      .filter((r): r is PromiseFulfilledResult<TokenSummary> => r.status === "fulfilled")
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
    return arr.slice(-(opts?.limit ?? 500));
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
    const [rewards, fees] = (await this.publicClient.multicall({
      allowFailure: true,
      contracts: [
        { address: token, abi: tokenAbi, functionName: "totalRewardsDistributed" },
        { address: this.v4.hook, abi: hookAbi, functionName: "creatorClaimable", args: [token] },
      ],
    })) as any[];
    return {
      stock: core?.stock ?? ("0x0000000000000000000000000000000000000000" as Address),
      taxBps: core?.taxBps ?? 0,
      totalRewards: rewards.status === "success" ? (rewards.result as bigint) : 0n,
      creatorFees: fees.status === "success" ? (fees.result as bigint) : 0n,
    };
  }

  /** USD market cap per unit of WETH-per-token price (for the chart axis). */
  async mcapScale(token: Address): Promise<number> {
    await this.loadCores();
    const core = this.cores.get(token.toLowerCase());
    const supplyWhole = core ? Number(core.totalSupply) / 1e18 : 1e9;
    const scale = this.nativeUsd * supplyWhole;
    return scale > 0 ? scale : 1;
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

  async buyToken(token: Address, valueWei: bigint, minOut: bigint = 0n): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: this.v4.router,
      abi: routerAbi,
      functionName: "buy",
      args: [token, minOut],
      value: valueWei,
    });
  }

  async sellToken(token: Address, amount: bigint, minOut: bigint = 0n): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    const account = this.account();
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
      args: [token, amount, minOut],
    });
  }

  async claimCreatorFees(token: Address): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    return wc.writeContract({
      account: this.account(),
      chain: wc.chain,
      address: this.v4.hook,
      abi: hookAbi,
      functionName: "claimCreatorFees",
      args: [token],
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
   *  (50/25/25). Permissionless — anyone can trigger it for a token. */
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

  /** Launch a token. Mines a CREATE2 salt so its address ends in 4663. */
  async createToken(params: {
    name: string;
    symbol: string;
    metadataURI?: string;
    stock: Address;
    taxBps: number;
  }): Promise<`0x${string}`> {
    const wc = this.requireWallet();
    const creator = this.account();
    const metadataURI = params.metadataURI ?? "";
    const args = encodeAbiParameters(
      [
        { type: "string" }, { type: "string" }, { type: "string" }, { type: "uint256" },
        { type: "address" }, { type: "address" }, { type: "uint16" }, { type: "address" },
      ],
      [params.name, params.symbol, metadataURI, TOTAL_SUPPLY, creator, this.v4.factory, params.taxBps, params.stock],
    );
    const initCodeHash = keccak256(concatHex([QUIVER_TOKEN_BYTECODE as `0x${string}`, args]));
    let salt: `0x${string}` | null = null;
    for (let i = 0n; i < 2_000_000n; i++) {
      const s = `0x${i.toString(16).padStart(64, "0")}` as `0x${string}`;
      const addr = getContractAddress({ opcode: "CREATE2", from: this.v4.factory, salt: s, bytecodeHash: initCodeHash });
      if ((BigInt(addr) & 0xffffn) === 0x4663n) {
        salt = s;
        break;
      }
    }
    if (!salt) throw new Error("Could not mine a launch address. Try again.");
    return wc.writeContract({
      account: creator,
      chain: wc.chain,
      address: this.v4.factory,
      abi: factoryAbi,
      functionName: "launch",
      args: [
        { name: params.name, symbol: params.symbol, metadataURI, stock: params.stock, taxBps: params.taxBps },
        salt,
      ],
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
    const id = setInterval(() => {
      this.tradesCache.delete(token.toLowerCase());
      this.loadTrades(token).then((tr) => tr.length && cb(tr[tr.length - 1])).catch(() => undefined);
    }, 12_000);
    return () => clearInterval(id);
  }
  subscribeToPrice(_token: Address, _cb: (u: unknown) => void): () => void {
    return () => undefined;
  }
  subscribeToCandles(token: Address, interval: CandleInterval, cb: (u: { candle: Candle }) => void): () => void {
    const id = setInterval(() => {
      this.tradesCache.delete(token.toLowerCase());
      this.getCandles(token, interval, { limit: 1 }).then((c) => c.length && cb({ candle: c[c.length - 1] })).catch(() => undefined);
    }, 15_000);
    return () => clearInterval(id);
  }

  close() {}

  // Convenience for parity with the v3 client used by helpers.
  parseEther = parseEther;
}
