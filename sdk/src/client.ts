import {
  createPublicClient,
  http,
  parseEther,
  type Chain,
  type PublicClient,
  type WalletClient,
  type Hash,
} from "viem";

import { launchpadAbi, launchTokenAbi } from "./abi";
import { ChainDataSource } from "./chain-data";
import { LaunchpadSocket } from "./ws";
import type {
  Address,
  Candle,
  CandleInterval,
  CandleUpdate,
  CreateTokenParams,
  CreatorStats,
  HolderRecord,
  LaunchpadAddresses,
  PlatformStats,
  PoolInfo,
  PriceUpdate,
  TokenSummary,
  TradeRecord,
  TradingLimits,
} from "./types";

export interface LaunchpadClientConfig {
  /** Deployed contract addresses on Robinhood Chain. */
  addresses: LaunchpadAddresses;
  /** Chain definition (id, rpcUrls) used when publicClient is not provided. */
  chain?: Chain;
  rpcUrl?: string;
  /** Bring your own viem clients if you already have them. */
  publicClient?: PublicClient;
  walletClient?: WalletClient;
  /** Backend REST base URL. Leave empty to read everything directly from
   *  the chain (backend-free mode): tokens, trades, candles and holders come
   *  from RPC and live updates from event watching. */
  apiUrl?: string;
  /** First block to scan in backend-free mode (the launchpad deploy block). */
  startBlock?: bigint;
  /** Backend WebSocket URL, e.g. wss://api.yourlaunchpad.xyz/ws */
  wsUrl?: string;
  fetchFn?: typeof fetch;
}

/**
 * Launchpad SDK. On-chain writes go through a viem WalletClient (real
 * transaction signing, no custodied keys); reads come from the chain and the
 * indexer API; live data streams over WebSocket.
 */
export class LaunchpadClient {
  readonly addresses: LaunchpadAddresses;
  readonly publicClient: PublicClient;
  private walletClient?: WalletClient;
  private apiUrl: string;
  private socket?: LaunchpadSocket;
  private chainData?: ChainDataSource;
  private fetchFn: typeof fetch;

  constructor(config: LaunchpadClientConfig) {
    this.addresses = config.addresses;
    this.apiUrl = (config.apiUrl ?? "").replace(/\/$/, "");
    this.fetchFn = config.fetchFn ?? fetch.bind(globalThis);

    if (config.publicClient) {
      this.publicClient = config.publicClient;
    } else if (config.chain) {
      // Batch concurrent JSON-RPC calls, and fold concurrent eth_calls into a
      // single Multicall3 request, so a screen full of tokens costs one round
      // trip instead of dozens. Short caches dedupe repeated static reads.
      this.publicClient = createPublicClient({
        chain: config.chain,
        transport: http(config.rpcUrl ?? config.chain.rpcUrls.default.http[0], {
          batch: { wait: 16 },
        }),
        batch: { multicall: { wait: 16 } },
        cacheTime: 4_000,
      });
    } else {
      throw new Error("Provide either publicClient or chain in LaunchpadClientConfig");
    }

    this.walletClient = config.walletClient;
    if (config.wsUrl) this.socket = new LaunchpadSocket(config.wsUrl);
    if (!this.apiUrl) {
      this.chainData = new ChainDataSource(this.publicClient, this.addresses, config.startBlock);
    }
  }

  /** Attach or replace the signing wallet (e.g. after the user connects). */
  connectWallet(walletClient: WalletClient) {
    this.walletClient = walletClient;
  }

  private requireWallet(): WalletClient {
    if (!this.walletClient) throw new Error("No wallet connected. Call connectWallet first.");
    return this.walletClient;
  }

  private async api<T>(path: string): Promise<T> {
    const res = await this.fetchFn(`${this.apiUrl}${path}`);
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status} ${await res.text()}`);
    return (await res.json()) as T;
  }

  // -------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------

  /** Launch a token: deploys the ERC-20, creates the V3 pool, seeds liquidity. */
  async createToken(params: CreateTokenParams): Promise<Hash> {
    const wallet = this.requireWallet();
    const [account] = await wallet.getAddresses();

    const metadataURI = JSON.stringify({
      description: params.description ?? "",
      logo: params.logo ?? "",
      website: params.website ?? "",
      twitter: params.twitter ?? "",
      telegram: params.telegram ?? "",
      links: params.links ?? [],
    });

    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "launch",
      args: [
        {
          name: params.name,
          symbol: params.symbol,
          metadataURI,
        },
      ],
      value: params.firstBuyWei ?? 0n,
    });
    return wallet.writeContract(request);
  }

  /** Buy tokens with native currency. */
  async buyToken(token: Address, valueWei: bigint, opts?: { minTokensOut?: bigint; deadlineSeconds?: number }): Promise<Hash> {
    const wallet = this.requireWallet();
    const [account] = await wallet.getAddresses();
    const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts?.deadlineSeconds ?? 300));

    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "buy",
      args: [token, opts?.minTokensOut ?? 0n, deadline],
      value: valueWei,
    });
    return wallet.writeContract(request);
  }

  /** Sell tokens for native currency. Handles the allowance automatically. */
  async sellToken(token: Address, amount: bigint, opts?: { minNativeOut?: bigint; deadlineSeconds?: number }): Promise<Hash> {
    const wallet = this.requireWallet();
    const [account] = await wallet.getAddresses();

    const allowance = await this.publicClient.readContract({
      address: token,
      abi: launchTokenAbi,
      functionName: "allowance",
      args: [account, this.addresses.factory],
    });
    if (allowance < amount) {
      const { request: approveReq } = await this.publicClient.simulateContract({
        account,
        address: token,
        abi: launchTokenAbi,
        functionName: "approve",
        args: [this.addresses.factory, amount],
      });
      const approveHash = await wallet.writeContract(approveReq);
      await this.publicClient.waitForTransactionReceipt({ hash: approveHash });
    }

    const deadline = BigInt(Math.floor(Date.now() / 1000) + (opts?.deadlineSeconds ?? 300));
    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "sell",
      args: [token, amount, opts?.minNativeOut ?? 0n, deadline],
    });
    return wallet.writeContract(request);
  }

  /**
   * Claim the trading fees accrued to a token you created. Fees are not pushed
   * per trade; the creator pulls their 80% share per token with this call.
   */
  async claimCreatorFees(token: Address): Promise<Hash> {
    const wallet = this.requireWallet();
    const [account] = await wallet.getAddresses();
    const { request } = await this.publicClient.simulateContract({
      account,
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "claimCreatorFees",
      args: [token],
    });
    return wallet.writeContract(request);
  }

  // -------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------

  async getToken(token: Address): Promise<TokenSummary> {
    if (this.chainData) return this.chainData.getToken(token);
    return this.api<TokenSummary>(`/api/tokens/${token.toLowerCase()}`);
  }

  async getTokens(opts?: { sort?: "new" | "volume" | "marketCap" | "featured"; limit?: number; offset?: number }): Promise<TokenSummary[]> {
    if (this.chainData) return this.chainData.getTokens(opts?.sort ?? "new", opts?.limit ?? 50);
    const q = new URLSearchParams();
    if (opts?.sort) q.set("sort", opts.sort);
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.offset) q.set("offset", String(opts.offset));
    return this.api<TokenSummary[]>(`/api/tokens?${q}`);
  }

  /** Latest price in native wei per whole token, straight from the pool. */
  async getPrice(token: Address): Promise<{ priceWei: bigint; priceUsd: string }> {
    const [mcapWeth, mcapUsd, supply] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.factory,
        abi: launchpadAbi,
        functionName: "marketCapWeth",
        args: [token],
      }),
      this.publicClient.readContract({
        address: this.addresses.factory,
        abi: launchpadAbi,
        functionName: "marketCapUsd",
        args: [token],
      }),
      this.publicClient.readContract({ address: token, abi: launchTokenAbi, functionName: "totalSupply" }),
    ]);
    const priceWei = supply === 0n ? 0n : (mcapWeth * 10n ** 18n) / supply;
    const priceUsd = supply === 0n ? "0" : formatUsd8((mcapUsd * 10n ** 18n) / supply);
    return { priceWei, priceUsd };
  }

  async getMarketCap(token: Address): Promise<{ marketCapWeth: bigint; marketCapUsd: string }> {
    const [mcapWeth, mcapUsd] = await Promise.all([
      this.publicClient.readContract({
        address: this.addresses.factory,
        abi: launchpadAbi,
        functionName: "marketCapWeth",
        args: [token],
      }),
      this.publicClient.readContract({
        address: this.addresses.factory,
        abi: launchpadAbi,
        functionName: "marketCapUsd",
        args: [token],
      }),
    ]);
    return { marketCapWeth: mcapWeth, marketCapUsd: formatUsd8(mcapUsd) };
  }

  async getLiquidity(token: Address): Promise<{ poolLiquidity: bigint; positionLiquidity: bigint }> {
    const info = await this.getPoolInfoRaw(token);
    return { poolLiquidity: BigInt(info.poolLiquidity), positionLiquidity: BigInt(info.positionLiquidity) };
  }

  async getVolume(token: Address): Promise<{ volume24hWei: string; volumeTotalWei: string }> {
    const t = await this.getToken(token);
    return { volume24hWei: t.volume24hWei, volumeTotalWei: t.volumeTotalWei };
  }

  async getTrades(token: Address, opts?: { limit?: number; before?: number }): Promise<TradeRecord[]> {
    if (this.chainData) return this.chainData.getTrades(token, opts?.limit ?? 50);
    const q = new URLSearchParams({ token: token.toLowerCase() });
    if (opts?.limit) q.set("limit", String(opts.limit));
    if (opts?.before) q.set("before", String(opts.before));
    return this.api<TradeRecord[]>(`/api/trades?${q}`);
  }

  async getHolders(token: Address, opts?: { limit?: number }): Promise<HolderRecord[]> {
    if (this.chainData) return this.chainData.getHolders(token, opts?.limit ?? 50);
    const q = new URLSearchParams({ token: token.toLowerCase() });
    if (opts?.limit) q.set("limit", String(opts.limit));
    return this.api<HolderRecord[]>(`/api/holders?${q}`);
  }

  async getCandles(token: Address, interval: CandleInterval, opts?: { from?: number; to?: number; limit?: number }): Promise<Candle[]> {
    if (this.chainData) return this.chainData.getCandles(token, interval, opts?.limit ?? 500);
    const q = new URLSearchParams({ token: token.toLowerCase(), interval });
    if (opts?.from) q.set("from", String(opts.from));
    if (opts?.to) q.set("to", String(opts.to));
    if (opts?.limit) q.set("limit", String(opts.limit));
    return this.api<Candle[]>(`/api/candles?${q}`);
  }

  async getPoolInfoRaw(token: Address): Promise<PoolInfo> {
    const [pool, feeTier, sqrtPriceX96, tick, poolLiquidity, positionTokenId, positionLiquidity] =
      await this.publicClient.readContract({
        address: this.addresses.factory,
        abi: launchpadAbi,
        functionName: "poolInfo",
        args: [token],
      });
    return {
      pool,
      feeTier: Number(feeTier),
      sqrtPriceX96: sqrtPriceX96.toString(),
      tick: Number(tick),
      poolLiquidity: poolLiquidity.toString(),
      positionTokenId: positionTokenId.toString(),
      positionLiquidity: positionLiquidity.toString(),
    };
  }

  async getPoolInfo(token: Address): Promise<PoolInfo> {
    return this.getPoolInfoRaw(token);
  }

  /**
   * Trading is unrestricted from launch in this protocol: no max transaction,
   * max wallet, cooldown or graduation gate exists on-chain. Returned for API
   * compatibility with a constant "no limits, current market cap" shape.
   */
  async getTradingLimits(token: Address): Promise<TradingLimits> {
    const mcapUsd = await this.publicClient.readContract({
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "marketCapUsd",
      args: [token],
    });
    return {
      active: false,
      maxTxAmount: "0",
      maxWalletAmount: "0",
      buyCooldownSeconds: 0,
      marketCapUsd: formatUsd8(mcapUsd),
      remainingUsd: "0",
      graduationCapUsd: "0",
    };
  }

  async getPlatformStats(): Promise<PlatformStats> {
    return this.api<PlatformStats>("/api/stats");
  }

  async getCreatorStats(creator: Address): Promise<CreatorStats> {
    return this.api<CreatorStats>(`/api/creators/${creator.toLowerCase()}`);
  }

  /** Unclaimed creator fees for a single token (native wei). */
  async getCreatorPending(token: Address): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.addresses.factory,
      abi: launchpadAbi,
      functionName: "creatorFeesAccrued",
      args: [token],
    });
  }

  // -------------------------------------------------------------------
  // Live subscriptions
  // -------------------------------------------------------------------

  private requireStream(): { subscribe: (channel: any, params: any, fn: any) => () => void } {
    if (this.chainData) return this.chainData as any;
    if (!this.socket) throw new Error("No wsUrl configured for LaunchpadClient");
    return this.socket as any;
  }

  subscribeToPrice(token: Address, onUpdate: (update: PriceUpdate) => void): () => void {
    return this.requireStream().subscribe("price:update", { token }, (msg: any) => {
      if (msg.channel === "price:update") onUpdate(msg.data);
    });
  }

  subscribeToTrades(token: Address, onTrade: (trade: TradeRecord) => void): () => void {
    return this.requireStream().subscribe("trade:update", { token }, (msg: any) => {
      if (msg.channel === "trade:update") onTrade(msg.data);
    });
  }

  subscribeToCandles(token: Address, interval: CandleInterval, onCandle: (update: CandleUpdate) => void): () => void {
    return this.requireStream().subscribe("candle:update", { token, interval }, (msg: any) => {
      if (msg.channel === "candle:update" && msg.data.interval === interval) onCandle(msg.data);
    });
  }

  subscribeToLaunches(onLaunch: (token: TokenSummary) => void): () => void {
    return this.requireStream().subscribe("token:launched", {}, (msg: any) => {
      if (msg.channel === "token:launched") onLaunch(msg.data);
    });
  }

  disconnect() {
    this.socket?.close();
    this.chainData?.close();
  }
}

/** Formats an 8-decimal USD bigint as a decimal string, e.g. 4000000000000n -> "40000". */
export function formatUsd8(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10n ** 8n;
  const frac = (abs % 10n ** 8n).toString().padStart(8, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${frac ? "." + frac : ""}`;
}

export { parseEther };
