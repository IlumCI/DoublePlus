import type Database from "better-sqlite3";
import {
  createPublicClient,
  http,
  parseAbiItem,
  type Log,
  type PublicClient,
} from "viem";
import { launchpadAbi, launchTokenAbi, feeDistributorAbi, INTERVAL_SECONDS, type CandleInterval } from "@launchpad/sdk";

import { config } from "./config";
import { getMeta, setMeta } from "./db";
import { Hub } from "./hub";
import { priceWeiFromSqrtPrice, usd8ToString, weiToEth } from "./math";
import { serializeToken } from "./serialize";

const erc20BalanceOfAbi = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

const INTERVALS = Object.keys(INTERVAL_SECONDS) as CandleInterval[];

interface TrackedToken {
  address: `0x${string}`;
  pool: `0x${string}`;
  tokenIsToken0: boolean;
}

/**
 * Blockchain indexer. Polls the chain for launchpad, fee distributor and
 * token events, maintains tokens/trades/candles/holders in SQLite and pushes
 * live updates through the WebSocket hub.
 */
export class Indexer {
  readonly client: PublicClient;
  private db: Database.Database;
  private hub: Hub;
  private tracked = new Map<string, TrackedToken>();
  private blockTs = new Map<string, number>();
  private stopped = false;

  constructor(db: Database.Database, hub: Hub) {
    this.db = db;
    this.hub = hub;
    this.client = createPublicClient({ transport: http(config.rpcUrl) });

    const rows = this.db
      .prepare("SELECT address, pool, token_is_token0 FROM tokens")
      .all() as { address: string; pool: string; token_is_token0?: number }[];
    for (const r of rows) {
      this.tracked.set(r.address.toLowerCase(), {
        address: r.address as `0x${string}`,
        pool: r.pool as `0x${string}`,
        tokenIsToken0: r.token_is_token0 !== 0,
      });
    }
  }

  async start() {
    this.loop().catch((err) => {
      console.error("indexer loop crashed", err);
      process.exit(1);
    });
    this.refreshLoop().catch((err) => console.error("refresh loop error", err));
  }

  stop() {
    this.stopped = true;
  }

  private lastBlock(): bigint {
    const v = getMeta(this.db, "lastBlock");
    return v ? BigInt(v) : config.startBlock - 1n;
  }

  private async loop() {
    while (!this.stopped) {
      try {
        const latest = await this.client.getBlockNumber();
        let last = this.lastBlock();
        while (last < latest && !this.stopped) {
          const from = last + 1n;
          const to =
            latest - from > BigInt(config.maxBlockRange)
              ? from + BigInt(config.maxBlockRange) - 1n
              : latest;
          await this.processRange(from, to);
          last = to;
          setMeta(this.db, "lastBlock", last.toString());
        }
      } catch (err) {
        console.error("indexing error", err);
      }
      await sleep(config.pollIntervalMs);
    }
  }

  private async processRange(fromBlock: bigint, toBlock: bigint) {
    const [launchpadLogs, feeLogs] = await Promise.all([
      this.client.getLogs({ address: config.launchpad, events: launchpadAbi.filter((x) => x.type === "event") as any, fromBlock, toBlock }),
      this.client.getLogs({ address: config.feeDistributor, events: feeDistributorAbi.filter((x) => x.type === "event") as any, fromBlock, toBlock }),
    ]);

    // Register tokens launched inside this range before fetching token logs,
    // so their Transfer events in the same range are not missed.
    for (const log of launchpadLogs as any[]) {
      if (log.eventName === "TokenLaunched") {
        const token = (log.args.token as string).toLowerCase();
        this.tracked.set(token, {
          address: token as `0x${string}`,
          pool: (log.args.pool as string).toLowerCase() as `0x${string}`,
          tokenIsToken0: token < config.weth.toLowerCase(),
        });
      }
    }

    const tokenAddresses = [...this.tracked.values()].map((t) => t.address);
    const tokenLogs = tokenAddresses.length
      ? await this.client.getLogs({ address: tokenAddresses, events: launchTokenAbi.filter((x) => x.type === "event") as any, fromBlock, toBlock })
      : ([] as Log[]);

    const logs = [...launchpadLogs, ...feeLogs, ...tokenLogs].sort((a: any, b: any) =>
      a.blockNumber === b.blockNumber
        ? Number(a.logIndex) - Number(b.logIndex)
        : Number(a.blockNumber - b.blockNumber)
    );
    if (logs.length === 0) return;

    // Resolve timestamps for every block touched in this range.
    const blockNumbers = [...new Set(logs.map((l: any) => l.blockNumber as bigint))];
    await Promise.all(
      blockNumbers.map(async (bn) => {
        const key = bn.toString();
        if (this.blockTs.has(key)) return;
        const block = await this.client.getBlock({ blockNumber: bn });
        this.blockTs.set(key, Number(block.timestamp));
        if (this.blockTs.size > 10_000) {
          const first = this.blockTs.keys().next().value;
          if (first !== undefined) this.blockTs.delete(first);
        }
      })
    );

    const touched = new Set<string>();
    for (const log of logs as any[]) {
      const ts = this.blockTs.get(log.blockNumber.toString()) ?? Math.floor(Date.now() / 1000);
      try {
        this.processLog(log, ts, touched);
      } catch (err) {
        console.error(`failed to process log ${log.transactionHash}#${log.logIndex}`, err);
      }
    }

    for (const token of touched) {
      await this.refreshTokenState(token as `0x${string}`).catch((err) =>
        console.error(`refresh failed for ${token}`, err)
      );
    }
  }

  private processLog(log: any, ts: number, touched: Set<string>) {
    switch (log.eventName) {
      case "TokenLaunched":
        this.onTokenLaunched(log, ts);
        touched.add((log.args.token as string).toLowerCase());
        break;
      case "Trade":
        this.onTrade(log, ts);
        touched.add((log.args.token as string).toLowerCase());
        break;
      case "Transfer":
        this.onTransfer(log);
        break;
      case "LimitsRemoved": {
        const token = (log.address as string).toLowerCase();
        this.db.prepare("UPDATE tokens SET limits_active = 0 WHERE address = ?").run(token);
        touched.add(token);
        break;
      }
      case "FeeAccrued":
        this.db
          .prepare(
            `INSERT OR IGNORE INTO fee_events
             (token, creator, creator_wei, platform_wei, creator_eth, platform_eth, block, tx_hash, log_index, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            (log.args.token as string).toLowerCase(),
            (log.args.creator as string).toLowerCase(),
            log.args.amount.toString(),
            "0",
            weiToEth(log.args.amount),
            0,
            Number(log.blockNumber),
            log.transactionHash,
            Number(log.logIndex),
            ts
          );
        break;
      case "FeesCollected":
      case "LiquidityAdded": {
        const token = (log.args.token as string).toLowerCase();
        this.db
          .prepare(
            `INSERT OR IGNORE INTO lp_events
             (token, kind, token_amount, weth_amount, block, tx_hash, log_index, ts)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run(
            token,
            log.eventName,
            (log.args.tokenAmount ?? 0n).toString(),
            (log.args.wethAmount ?? 0n).toString(),
            Number(log.blockNumber),
            log.transactionHash,
            Number(log.logIndex),
            ts
          );
        touched.add(token);
        break;
      }
      case "TokenFeaturedSet":
        this.db
          .prepare("UPDATE tokens SET featured = ? WHERE address = ?")
          .run(log.args.featured ? 1 : 0, (log.args.token as string).toLowerCase());
        break;
      default:
        break;
    }
  }

  private onTokenLaunched(log: any, ts: number) {
    const token = (log.args.token as string).toLowerCase();
    const pool = (log.args.pool as string).toLowerCase();
    const tokenIsToken0 = token < config.weth.toLowerCase();

    let metadata = "{}";
    try {
      metadata = JSON.stringify(JSON.parse(log.args.metadataURI));
    } catch {
      metadata = JSON.stringify({ description: String(log.args.metadataURI ?? "") });
    }

    this.db
      .prepare(
        `INSERT OR IGNORE INTO tokens
         (address, name, symbol, metadata, creator, pool, position_token_id, fee_tier,
          created_at, launch_block, token_is_token0, total_supply, max_tx, max_wallet, buy_cooldown)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token,
        log.args.name,
        log.args.symbol,
        metadata,
        (log.args.creator as string).toLowerCase(),
        pool,
        log.args.positionTokenId.toString(),
        Number(log.args.feeTier),
        ts,
        Number(log.blockNumber),
        tokenIsToken0 ? 1 : 0,
        log.args.totalSupply.toString(),
        log.args.maxTxAmount.toString(),
        log.args.maxWalletAmount.toString(),
        Number(log.args.buyCooldown)
      );

    this.tracked.set(token, { address: token as `0x${string}`, pool: pool as `0x${string}`, tokenIsToken0 });

    const row = this.db.prepare("SELECT * FROM tokens WHERE address = ?").get(token);
    this.hub.broadcast("token:launched", token, serializeToken(this.db, row as any));
  }

  private onTrade(log: any, ts: number) {
    const token = (log.args.token as string).toLowerCase();
    const tracked = this.tracked.get(token);
    const tokenIsToken0 = tracked ? tracked.tokenIsToken0 : token < config.weth.toLowerCase();

    const priceWei = priceWeiFromSqrtPrice(log.args.sqrtPriceX96After, tokenIsToken0);
    const nativeWei = log.args.nativeAmount as bigint;
    const nativeEth = weiToEth(nativeWei);

    const result = this.db
      .prepare(
        `INSERT OR IGNORE INTO trades
         (token, trader, is_buy, native_wei, native_eth, token_amount, fee_wei, price_wei, block, tx_hash, log_index, ts)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token,
        (log.args.trader as string).toLowerCase(),
        log.args.isBuy ? 1 : 0,
        nativeWei.toString(),
        nativeEth,
        log.args.tokenAmount.toString(),
        log.args.feeAmount.toString(),
        priceWei.toString(),
        Number(log.blockNumber),
        log.transactionHash,
        Number(log.logIndex),
        ts
      );
    if (result.changes === 0) return; // duplicate

    // Token-level running totals and latest price.
    const row = this.db
      .prepare("SELECT volume_total_wei FROM tokens WHERE address = ?")
      .get(token) as { volume_total_wei: string } | undefined;
    if (row) {
      const newTotal = BigInt(row.volume_total_wei) + nativeWei;
      this.db
        .prepare(
          `UPDATE tokens SET price_wei = ?, volume_total_wei = ?,
           volume_total_eth = volume_total_eth + ? WHERE address = ?`
        )
        .run(priceWei.toString(), newTotal.toString(), nativeEth, token);
    }

    // OHLC aggregation across every interval.
    const priceEth = Number(priceWei) / 1e18;
    for (const interval of INTERVALS) {
      const bucket = ts - (ts % INTERVAL_SECONDS[interval]);
      this.db
        .prepare(
          `INSERT INTO candles (token, interval, time, open, high, low, close, volume)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (token, interval, time) DO UPDATE SET
             high = MAX(high, excluded.high),
             low = MIN(low, excluded.low),
             close = excluded.close,
             volume = volume + excluded.volume`
        )
        .run(token, interval, bucket, priceEth, priceEth, priceEth, priceEth, nativeEth);

      const candle = this.db
        .prepare("SELECT time, open, high, low, close, volume FROM candles WHERE token = ? AND interval = ? AND time = ?")
        .get(token, interval, bucket) as any;
      this.hub.broadcast(
        "candle:update",
        token,
        {
          token,
          interval,
          candle: {
            time: candle.time,
            open: String(candle.open),
            high: String(candle.high),
            low: String(candle.low),
            close: String(candle.close),
            volume: String(candle.volume),
          },
        },
        interval
      );
    }

    this.hub.broadcast("trade:update", token, {
      id: `${log.transactionHash}-${log.logIndex}`,
      token,
      trader: (log.args.trader as string).toLowerCase(),
      isBuy: Boolean(log.args.isBuy),
      nativeAmountWei: nativeWei.toString(),
      tokenAmount: log.args.tokenAmount.toString(),
      feeWei: log.args.feeAmount.toString(),
      priceWei: priceWei.toString(),
      blockNumber: Number(log.blockNumber),
      txHash: log.transactionHash,
      timestamp: ts,
    });
  }

  private onTransfer(log: any) {
    const token = (log.address as string).toLowerCase();
    const from = (log.args.from as string).toLowerCase();
    const to = (log.args.to as string).toLowerCase();
    const value = log.args.value as bigint;
    if (value === 0n) return;

    const zero = "0x0000000000000000000000000000000000000000";
    const adjust = this.db.prepare(
      `INSERT INTO holders (token, address, balance, balance_num) VALUES (?, ?, ?, ?)
       ON CONFLICT (token, address) DO UPDATE SET balance = excluded.balance, balance_num = excluded.balance_num`
    );
    const get = this.db.prepare("SELECT balance FROM holders WHERE token = ? AND address = ?");

    if (from !== zero) {
      const row = get.get(token, from) as { balance: string } | undefined;
      const next = (row ? BigInt(row.balance) : 0n) - value;
      if (next <= 0n) {
        this.db.prepare("DELETE FROM holders WHERE token = ? AND address = ?").run(token, from);
      } else {
        adjust.run(token, from, next.toString(), weiToEth(next));
      }
    }
    if (to !== zero) {
      const row = get.get(token, to) as { balance: string } | undefined;
      const next = (row ? BigInt(row.balance) : 0n) + value;
      adjust.run(token, to, next.toString(), weiToEth(next));
    }
  }

  /**
   * Re-reads live chain state for a token (price, market cap, liquidity,
   * limit status) and pushes a price:update.
   */
  async refreshTokenState(token: `0x${string}`) {
    const tokenLower = token.toLowerCase();
    const info = this.tracked.get(tokenLower);
    if (!info) return;

    const [poolInfo, limits, wethInPool] = await Promise.all([
      this.client.readContract({
        address: config.launchpad,
        abi: launchpadAbi,
        functionName: "poolInfo",
        args: [token],
      }),
      this.client.readContract({
        address: config.launchpad,
        abi: launchpadAbi,
        functionName: "tradingLimits",
        args: [token],
      }),
      this.client.readContract({
        address: config.weth,
        abi: erc20BalanceOfAbi,
        functionName: "balanceOf",
        args: [info.pool],
      }),
    ]);

    const [, , sqrtPriceX96] = poolInfo;
    const [active, , , , mcapUsd, remainingUsd] = limits;

    const priceWei = priceWeiFromSqrtPrice(sqrtPriceX96, info.tokenIsToken0);
    // Both sides of a full-range position are worth roughly the same, so the
    // pool's native-side balance doubled is a good liquidity figure.
    const liquidityWei = wethInPool * 2n;

    const supplyRow = this.db
      .prepare("SELECT total_supply FROM tokens WHERE address = ?")
      .get(tokenLower) as { total_supply: string } | undefined;
    const supply = supplyRow ? BigInt(supplyRow.total_supply) : 0n;
    const priceUsd =
      supply > 0n ? String((Number(mcapUsd) / 1e8 / Number(supply)) * 1e18) : "0";

    this.db
      .prepare(
        `UPDATE tokens SET price_wei = ?, price_usd = ?, market_cap_usd = ?,
         remaining_usd = ?, liquidity_wei = ?, limits_active = ? WHERE address = ?`
      )
      .run(
        priceWei.toString(),
        priceUsd,
        usd8ToString(mcapUsd),
        usd8ToString(remainingUsd),
        liquidityWei.toString(),
        active ? 1 : 0,
        tokenLower
      );

    this.hub.broadcast("price:update", tokenLower, {
      token: tokenLower,
      priceWei: priceWei.toString(),
      priceUsd,
      marketCapUsd: usd8ToString(mcapUsd),
      liquidityWei: liquidityWei.toString(),
      limitsActive: Boolean(active),
      remainingToGraduationUsd: usd8ToString(remainingUsd),
    });
  }

  /** Periodic full refresh so idle tokens stay current (native/USD drift etc.). */
  private async refreshLoop() {
    while (!this.stopped) {
      await sleep(config.refreshIntervalMs);
      for (const token of this.tracked.values()) {
        if (this.stopped) return;
        await this.refreshTokenState(token.address).catch(() => undefined);
      }
    }
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
