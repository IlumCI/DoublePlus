import Database from "better-sqlite3";
import * as fs from "fs";
import * as path from "path";

import { config } from "./config";

export function openDb(): Database.Database {
  fs.mkdirSync(path.dirname(path.resolve(config.dbPath)), { recursive: true });
  const db = new Database(config.dbPath);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL");

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS tokens (
      address TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      symbol TEXT NOT NULL,
      metadata TEXT NOT NULL DEFAULT '{}',
      creator TEXT NOT NULL,
      pool TEXT NOT NULL,
      position_token_id TEXT NOT NULL,
      fee_tier INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      launch_block INTEGER NOT NULL,
      token_is_token0 INTEGER NOT NULL DEFAULT 1,
      featured INTEGER NOT NULL DEFAULT 0,
      total_supply TEXT NOT NULL,
      max_tx TEXT NOT NULL,
      max_wallet TEXT NOT NULL,
      buy_cooldown INTEGER NOT NULL,
      limits_active INTEGER NOT NULL DEFAULT 1,
      price_wei TEXT NOT NULL DEFAULT '0',
      price_usd TEXT NOT NULL DEFAULT '0',
      market_cap_usd TEXT NOT NULL DEFAULT '0',
      remaining_usd TEXT NOT NULL DEFAULT '0',
      liquidity_wei TEXT NOT NULL DEFAULT '0',
      volume_total_wei TEXT NOT NULL DEFAULT '0',
      volume_total_eth REAL NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      trader TEXT NOT NULL,
      is_buy INTEGER NOT NULL,
      native_wei TEXT NOT NULL,
      native_eth REAL NOT NULL,
      token_amount TEXT NOT NULL,
      fee_wei TEXT NOT NULL,
      price_wei TEXT NOT NULL,
      block INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS trades_token_ts ON trades (token, ts DESC);
    CREATE INDEX IF NOT EXISTS trades_ts ON trades (ts DESC);
    CREATE INDEX IF NOT EXISTS trades_trader ON trades (trader);

    CREATE TABLE IF NOT EXISTS candles (
      token TEXT NOT NULL,
      interval TEXT NOT NULL,
      time INTEGER NOT NULL,
      open REAL NOT NULL,
      high REAL NOT NULL,
      low REAL NOT NULL,
      close REAL NOT NULL,
      volume REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (token, interval, time)
    );

    CREATE TABLE IF NOT EXISTS holders (
      token TEXT NOT NULL,
      address TEXT NOT NULL,
      balance TEXT NOT NULL,
      balance_num REAL NOT NULL DEFAULT 0,
      PRIMARY KEY (token, address)
    );
    CREATE INDEX IF NOT EXISTS holders_token_balance ON holders (token, balance_num DESC);

    CREATE TABLE IF NOT EXISTS fee_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      creator TEXT NOT NULL,
      creator_wei TEXT NOT NULL,
      platform_wei TEXT NOT NULL,
      creator_eth REAL NOT NULL,
      platform_eth REAL NOT NULL,
      block INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index)
    );
    CREATE INDEX IF NOT EXISTS fee_events_creator ON fee_events (creator, ts DESC);

    CREATE TABLE IF NOT EXISTS lp_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL,
      kind TEXT NOT NULL,
      token_amount TEXT NOT NULL,
      weth_amount TEXT NOT NULL,
      block INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE (tx_hash, log_index, kind)
    );
    CREATE INDEX IF NOT EXISTS lp_events_token ON lp_events (token, ts DESC);
  `);

  return db;
}

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: Database.Database, key: string, value: string) {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  ).run(key, value);
}
