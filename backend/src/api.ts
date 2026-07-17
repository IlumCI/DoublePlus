import type Database from "better-sqlite3";
import cors from "cors";
import express, { type Express } from "express";
import { launchpadAbi, feeDistributorAbi, INTERVAL_SECONDS } from "@launchpad/sdk";
import type { PublicClient } from "viem";

import { config } from "./config";
import { serializeToken, type TokenRow } from "./serialize";

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

export function createApi(db: Database.Database, client: PublicClient): Express {
  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/api/health", (_req, res) => {
    res.json({ ok: true });
  });

  // ------------------------------------------------------------------
  // Tokens
  // ------------------------------------------------------------------
  app.get("/api/tokens", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 50), 200);
    const offset = Math.max(Number(req.query.offset ?? 0), 0);
    const sort = String(req.query.sort ?? "new");

    let orderBy = "created_at DESC";
    let where = "";
    if (sort === "volume") orderBy = "volume_total_eth DESC";
    if (sort === "marketCap") orderBy = "CAST(market_cap_usd AS REAL) DESC";
    if (sort === "featured") {
      where = "WHERE featured = 1";
      orderBy = "created_at DESC";
    }

    const rows = db
      .prepare(`SELECT * FROM tokens ${where} ORDER BY ${orderBy} LIMIT ? OFFSET ?`)
      .all(limit, offset) as TokenRow[];
    res.json(rows.map((r) => serializeToken(db, r)));
  });

  app.get("/api/tokens/:address", (req, res) => {
    const address = String(req.params.address).toLowerCase();
    if (!ADDRESS_RE.test(address)) return res.status(400).json({ error: "bad address" });
    const row = db.prepare("SELECT * FROM tokens WHERE address = ?").get(address) as
      | TokenRow
      | undefined;
    if (!row) return res.status(404).json({ error: "token not found" });
    res.json(serializeToken(db, row));
  });

  // ------------------------------------------------------------------
  // Candles: GET /api/candles?token=0x..&interval=1m&from=&to=&limit=
  // ------------------------------------------------------------------
  app.get("/api/candles", (req, res) => {
    const token = String(req.query.token ?? "").toLowerCase();
    const interval = String(req.query.interval ?? "1m");
    if (!ADDRESS_RE.test(token)) return res.status(400).json({ error: "bad token" });
    if (!(interval in INTERVAL_SECONDS)) return res.status(400).json({ error: "bad interval" });

    const limit = Math.min(Number(req.query.limit ?? 500), 2000);
    const to = Number(req.query.to ?? Math.floor(Date.now() / 1000));
    const from = Number(req.query.from ?? 0);

    const rows = db
      .prepare(
        `SELECT time, open, high, low, close, volume FROM candles
         WHERE token = ? AND interval = ? AND time >= ? AND time <= ?
         ORDER BY time DESC LIMIT ?`
      )
      .all(token, interval, from, to, limit) as any[];

    rows.reverse();
    res.json(
      rows.map((r) => ({
        time: r.time,
        open: String(r.open),
        high: String(r.high),
        low: String(r.low),
        close: String(r.close),
        volume: String(r.volume),
      }))
    );
  });

  // ------------------------------------------------------------------
  // Trades
  // ------------------------------------------------------------------
  app.get("/api/trades", (req, res) => {
    const token = String(req.query.token ?? "").toLowerCase();
    if (!ADDRESS_RE.test(token)) return res.status(400).json({ error: "bad token" });
    const limit = Math.min(Number(req.query.limit ?? 50), 500);
    const before = Number(req.query.before ?? 0);

    const rows = (
      before > 0
        ? db
            .prepare(
              `SELECT * FROM trades WHERE token = ? AND ts < ? ORDER BY ts DESC, id DESC LIMIT ?`
            )
            .all(token, before, limit)
        : db.prepare(`SELECT * FROM trades WHERE token = ? ORDER BY ts DESC, id DESC LIMIT ?`).all(token, limit)
    ) as any[];

    res.json(
      rows.map((r) => ({
        id: `${r.tx_hash}-${r.log_index}`,
        token: r.token,
        trader: r.trader,
        isBuy: Boolean(r.is_buy),
        nativeAmountWei: r.native_wei,
        tokenAmount: r.token_amount,
        feeWei: r.fee_wei,
        priceWei: r.price_wei,
        blockNumber: r.block,
        txHash: r.tx_hash,
        timestamp: r.ts,
      }))
    );
  });

  // ------------------------------------------------------------------
  // Holders
  // ------------------------------------------------------------------
  app.get("/api/holders", (req, res) => {
    const token = String(req.query.token ?? "").toLowerCase();
    if (!ADDRESS_RE.test(token)) return res.status(400).json({ error: "bad token" });
    const limit = Math.min(Number(req.query.limit ?? 50), 500);

    const supplyRow = db.prepare("SELECT total_supply FROM tokens WHERE address = ?").get(token) as
      | { total_supply: string }
      | undefined;
    const supply = supplyRow ? Number(supplyRow.total_supply) / 1e18 : 0;

    const rows = db
      .prepare(
        `SELECT address, balance, balance_num FROM holders
         WHERE token = ? ORDER BY balance_num DESC LIMIT ?`
      )
      .all(token, limit) as any[];

    res.json(
      rows.map((r) => ({
        address: r.address,
        balance: r.balance,
        pct: supply > 0 ? (r.balance_num / supply) * 100 : 0,
      }))
    );
  });

  // ------------------------------------------------------------------
  // Platform stats
  // ------------------------------------------------------------------
  app.get("/api/stats", async (_req, res) => {
    try {
      const dayAgo = Math.floor(Date.now() / 1000) - 86400;
      const tokens = (db.prepare("SELECT COUNT(*) AS c FROM tokens").get() as { c: number }).c;
      const tokens24h = (
        db.prepare("SELECT COUNT(*) AS c FROM tokens WHERE created_at >= ?").get(dayAgo) as {
          c: number;
        }
      ).c;
      const vol24 = (
        db.prepare("SELECT COALESCE(SUM(native_eth), 0) AS v FROM trades WHERE ts >= ?").get(dayAgo) as {
          v: number;
        }
      ).v;

      const [totalVolume, totalFees] = await Promise.all([
        client.readContract({ address: config.launchpad, abi: launchpadAbi, functionName: "totalTradeVolumeWei" }),
        client.readContract({ address: config.launchpad, abi: launchpadAbi, functionName: "totalFeesWei" }),
      ]);
      const creatorPayouts = sumColumn(db, "fee_events", "creator_wei");

      res.json({
        totalLaunches: tokens,
        totalVolumeWei: totalVolume.toString(),
        totalFeesWei: totalFees.toString(),
        creatorPayoutsWei: creatorPayouts.toString(),
        platformRevenueWei: "0",
        tokens24h,
        volume24hWei: (BigInt(Math.round(vol24 * 1e6)) * 10n ** 12n).toString(),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ------------------------------------------------------------------
  // Creator dashboard
  // ------------------------------------------------------------------
  app.get("/api/creators/:address", async (req, res) => {
    const creator = String(req.params.address).toLowerCase();
    if (!ADDRESS_RE.test(creator)) return res.status(400).json({ error: "bad address" });

    try {
      const rows = db
        .prepare("SELECT * FROM tokens WHERE creator = ? ORDER BY created_at DESC")
        .all(creator) as TokenRow[];

      const volume = rows.reduce((acc, r) => acc + r.volume_total_eth, 0);

      const [pending, lifetime] = await Promise.all([
        client.readContract({
          address: config.feeDistributor,
          abi: feeDistributorAbi,
          functionName: "creatorPending",
          args: [creator as `0x${string}`],
        }),
        client.readContract({
          address: config.feeDistributor,
          abi: feeDistributorAbi,
          functionName: "creatorLifetimeEarned",
          args: [creator as `0x${string}`],
        }),
      ]);

      res.json({
        address: creator,
        tokensLaunched: rows.length,
        totalVolumeWei: (BigInt(Math.round(volume * 1e6)) * 10n ** 12n).toString(),
        lifetimeEarnedWei: lifetime.toString(),
        pendingWei: pending.toString(),
        tokens: rows.map((r) => serializeToken(db, r)),
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // Revenue history for the creator dashboard.
  app.get("/api/creators/:address/revenue", (req, res) => {
    const creator = String(req.params.address).toLowerCase();
    if (!ADDRESS_RE.test(creator)) return res.status(400).json({ error: "bad address" });
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const rows = db
      .prepare(
        `SELECT token, creator_wei, platform_wei, block, tx_hash, ts
         FROM fee_events WHERE creator = ? ORDER BY ts DESC LIMIT ?`
      )
      .all(creator, limit) as any[];
    res.json(
      rows.map((r) => ({
        token: r.token,
        creatorAmountWei: r.creator_wei,
        platformAmountWei: r.platform_wei,
        blockNumber: r.block,
        txHash: r.tx_hash,
        timestamp: r.ts,
      }))
    );
  });

  // LP action history (admin dashboard).
  app.get("/api/lp-events", (req, res) => {
    const limit = Math.min(Number(req.query.limit ?? 100), 1000);
    const token = req.query.token ? String(req.query.token).toLowerCase() : null;
    const rows = (
      token
        ? db.prepare("SELECT * FROM lp_events WHERE token = ? ORDER BY ts DESC LIMIT ?").all(token, limit)
        : db.prepare("SELECT * FROM lp_events ORDER BY ts DESC LIMIT ?").all(limit)
    ) as any[];
    res.json(
      rows.map((r) => ({
        token: r.token,
        kind: r.kind,
        tokenAmount: r.token_amount,
        wethAmount: r.weth_amount,
        blockNumber: r.block,
        txHash: r.tx_hash,
        timestamp: r.ts,
      }))
    );
  });

  return app;
}

function sumColumn(db: Database.Database, table: string, column: string): bigint {
  const rows = db.prepare(`SELECT ${column} AS v FROM ${table}`).all() as { v: string }[];
  return rows.reduce((acc, r) => acc + BigInt(r.v), 0n);
}
