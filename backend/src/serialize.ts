import type Database from "better-sqlite3";

export interface TokenRow {
  address: string;
  name: string;
  symbol: string;
  metadata: string;
  creator: string;
  pool: string;
  position_token_id: string;
  fee_tier: number;
  created_at: number;
  launch_block: number;
  token_is_token0: number;
  featured: number;
  total_supply: string;
  max_tx: string;
  max_wallet: string;
  buy_cooldown: number;
  limits_active: number;
  price_wei: string;
  price_usd: string;
  market_cap_usd: string;
  remaining_usd: string;
  liquidity_wei: string;
  volume_total_wei: string;
  volume_total_eth: number;
}

/** Builds the API TokenSummary shape from a token row plus 24h aggregates. */
export function serializeToken(db: Database.Database, row: TokenRow) {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;

  const agg = db
    .prepare(
      `SELECT COALESCE(SUM(native_eth), 0) AS vol, COUNT(*) AS cnt
       FROM trades WHERE token = ? AND ts >= ?`
    )
    .get(row.address, dayAgo) as { vol: number; cnt: number };

  const feesRow = db
    .prepare("SELECT COALESCE(SUM(CAST(creator_wei AS TEXT)), '0') AS f FROM fee_events WHERE token = ?")
    .get(row.address) as { f: string };

  const holderCount = (
    db.prepare("SELECT COUNT(*) AS c FROM holders WHERE token = ?").get(row.address) as { c: number }
  ).c;

  // Price 24h ago: the close of the last candle before the cutoff.
  const ref = db
    .prepare(
      `SELECT close FROM candles WHERE token = ? AND interval = '1m' AND time <= ?
       ORDER BY time DESC LIMIT 1`
    )
    .get(row.address, dayAgo) as { close: number } | undefined;

  const currentPrice = Number(row.price_wei) / 1e18;
  const priceChange24hPct =
    ref && ref.close > 0 ? ((currentPrice - ref.close) / ref.close) * 100 : null;

  let metadata: Record<string, unknown> = {};
  try {
    metadata = JSON.parse(row.metadata);
  } catch {
    metadata = {};
  }

  return {
    address: row.address,
    name: row.name,
    symbol: row.symbol,
    creator: row.creator,
    pool: row.pool,
    feeTier: row.fee_tier,
    createdAt: row.created_at,
    featured: Boolean(row.featured),
    metadata,
    totalSupply: row.total_supply,
    priceWei: row.price_wei,
    priceUsd: row.price_usd,
    marketCapUsd: row.market_cap_usd,
    liquidityWei: row.liquidity_wei,
    volume24hWei: (BigInt(Math.round(agg.vol * 1e6)) * 10n ** 12n).toString(),
    volumeTotalWei: row.volume_total_wei,
    txCount24h: agg.cnt,
    holderCount,
    limitsActive: Boolean(row.limits_active),
    remainingToGraduationUsd: row.remaining_usd,
    priceChange24hPct,
    creatorFeesWei: String(feesRow.f ?? "0"),
    maxTxAmount: row.max_tx,
    maxWalletAmount: row.max_wallet,
    buyCooldownSeconds: row.buy_cooldown,
  };
}
