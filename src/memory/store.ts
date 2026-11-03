import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Balance, TokenClass } from "../core/types.js";
import { namespaceFor, type TideEvent } from "./events.js";

export interface User {
  id: number;
  chatId: number;
  wallet: string | null;
  budgetUsd: number | null;
  baseShare: number;
  alertsOn: boolean;
}

export interface Holding {
  id: string;
  userId: number;
  coinType: string;
  symbol: string;
  units: number;
  costUsd: number | null;
  entryPriceUsd: number | null;
  entryVolumeH24Usd: number | null;
  reason: string | null;
  boughtAt: string;
  closedAt: string | null;
}

export interface Alert {
  id: string;
  userId: number;
  poolAddress: string;
  coinType: string;
  symbol: string;
  tokenClass: TokenClass;
  priceUsd: number;
  sizeUsd: number | null;
  sentAt: string;
  action: string | null;
  changePct: number | null;
}

export type MemoryStatus = "queued" | "confirmed" | "failed" | "dry_run";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, namespace TEXT NOT NULL, type TEXT NOT NULL,
  user_id INTEGER, at TEXT NOT NULL, json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memory_log (
  event_id TEXT PRIMARY KEY, namespace TEXT NOT NULL, status TEXT NOT NULL,
  job_id TEXT, blob_id TEXT, error TEXT, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY, chat_id INTEGER NOT NULL, wallet TEXT, budget_usd REAL,
  base_share REAL NOT NULL DEFAULT 0.25, alerts_on INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS prefs (
  user_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL, PRIMARY KEY (user_id, key)
);
CREATE TABLE IF NOT EXISTS holdings (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, coin_type TEXT NOT NULL, symbol TEXT NOT NULL,
  units REAL NOT NULL, cost_usd REAL, entry_price_usd REAL, entry_volume_h24_usd REAL,
  reason TEXT, bought_at TEXT NOT NULL, closed_at TEXT
);
CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, pool_address TEXT NOT NULL, coin_type TEXT NOT NULL,
  symbol TEXT NOT NULL, token_class TEXT NOT NULL, price_usd REAL NOT NULL, size_usd REAL,
  sent_at TEXT NOT NULL, action TEXT, change_pct REAL
);
CREATE TABLE IF NOT EXISTS token_outcomes (
  id TEXT PRIMARY KEY, coin_type TEXT NOT NULL, token_class TEXT NOT NULL, change_pct REAL NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
  user_id INTEGER PRIMARY KEY, balances TEXT NOT NULL, at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_reasons (
  holding_id TEXT PRIMARY KEY, user_id INTEGER NOT NULL, asked_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_cooldown (
  pool_address TEXT PRIMARY KEY, alerted_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS holdings_user ON holdings(user_id, closed_at);
CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id, sent_at);
`;

/** Tables derived purely from events. Wiped and replayed by a rebuild. */
const DERIVED_TABLES = ["users", "prefs", "holdings", "alerts", "token_outcomes", "pending_reasons", "events"];

export class Store {
  readonly db: Database.Database;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(SCHEMA);
  }

  /** Apply an event to the cache. Idempotent: an event already applied is skipped. */
  apply(e: TideEvent): boolean {
    const inserted = this.db
      .prepare("INSERT OR IGNORE INTO events (id, namespace, type, user_id, at, json) VALUES (?, ?, ?, ?, ?, ?)")
      .run(e.id, namespaceFor(e), e.data.type, e.userId, e.at, JSON.stringify(e));
    if (inserted.changes === 0) return false;

    const d = e.data;
    const uid = e.userId;
    switch (d.type) {
      case "profile_set": {
        if (uid === null) break;
        this.db
          .prepare("INSERT INTO users (id, chat_id) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
          .run(uid, d.chatId ?? uid);
        const sets: string[] = [];
        const vals: unknown[] = [];
        if (d.chatId !== undefined) (sets.push("chat_id = ?"), vals.push(d.chatId));
        if (d.wallet !== undefined) (sets.push("wallet = ?"), vals.push(d.wallet));
        if (d.budgetUsd !== undefined) (sets.push("budget_usd = ?"), vals.push(d.budgetUsd));
        if (d.baseShare !== undefined) (sets.push("base_share = ?"), vals.push(d.baseShare));
        if (d.alertsOn !== undefined) (sets.push("alerts_on = ?"), vals.push(d.alertsOn ? 1 : 0));
        if (sets.length) this.db.prepare(`UPDATE users SET ${sets.join(", ")} WHERE id = ?`).run(...vals, uid);
        break;
      }
      case "buy_detected":
        if (uid === null) break;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO holdings (id, user_id, coin_type, symbol, units, cost_usd, entry_price_usd, entry_volume_h24_usd, bought_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(d.holdingId, uid, d.coinType, d.symbol, d.units, d.costUsd, d.priceUsd, d.volumeH24Usd, e.at);
        break;
      case "buy_reason":
        this.db.prepare("UPDATE holdings SET reason = ? WHERE id = ?").run(d.reason, d.holdingId);
        this.db.prepare("DELETE FROM pending_reasons WHERE holding_id = ?").run(d.holdingId);
        break;
      case "position_closed":
        this.db.prepare("UPDATE holdings SET closed_at = ? WHERE id = ?").run(e.at, d.holdingId);
        this.db.prepare("DELETE FROM pending_reasons WHERE holding_id = ?").run(d.holdingId);
        break;
      case "alert_sent":
        if (uid === null) break;
        this.db
          .prepare(
            `INSERT OR IGNORE INTO alerts (id, user_id, pool_address, coin_type, symbol, token_class, price_usd, size_usd, sent_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(d.alertId, uid, d.poolAddress, d.coinType, d.symbol, d.tokenClass, d.priceUsd, d.sizeUsd, e.at);
        break;
      case "alert_action":
        this.db.prepare("UPDATE alerts SET action = ? WHERE id = ?").run(d.action, d.alertId);
        break;
      case "alert_outcome":
        this.db.prepare("UPDATE alerts SET change_pct = ? WHERE id = ?").run(d.changePct, d.alertId);
        break;
      case "preference":
        if (uid === null) break;
        this.db
          .prepare("INSERT INTO prefs (user_id, key, value) VALUES (?, ?, ?) ON CONFLICT(user_id, key) DO UPDATE SET value = excluded.value")
          .run(uid, d.key, d.value);
        break;
      case "token_outcome":
        this.db
          .prepare("INSERT OR IGNORE INTO token_outcomes (id, coin_type, token_class, change_pct, at) VALUES (?, ?, ?, ?, ?)")
          .run(e.id, d.coinType, d.tokenClass, d.changePct, e.at);
        break;
    }
    return true;
  }

  /** Drop everything derived from events, ready for a replay from Walrus Memory. */
  wipeDerived(): void {
    const tx = this.db.transaction(() => {
      for (const t of DERIVED_TABLES) this.db.exec(`DELETE FROM ${t}`);
    });
    tx();
  }

  // ---- memory log -------------------------------------------------------

  logMemory(eventId: string, namespace: string, status: MemoryStatus, extra: { jobId?: string; blobId?: string; error?: string } = {}) {
    this.db
      .prepare(
        `INSERT INTO memory_log (event_id, namespace, status, job_id, blob_id, error, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET status = excluded.status,
           job_id = COALESCE(excluded.job_id, job_id), blob_id = COALESCE(excluded.blob_id, blob_id),
           error = excluded.error, updated_at = excluded.updated_at`,
      )
      .run(eventId, namespace, status, extra.jobId ?? null, extra.blobId ?? null, extra.error ?? null, new Date().toISOString());
  }

  memoryStats(namespace?: string): Record<MemoryStatus, number> {
    const rows = (
      namespace
        ? this.db.prepare("SELECT status, COUNT(*) n FROM memory_log WHERE namespace = ? GROUP BY status").all(namespace)
        : this.db.prepare("SELECT status, COUNT(*) n FROM memory_log GROUP BY status").all()
    ) as { status: MemoryStatus; n: number }[];
    const out = { queued: 0, confirmed: 0, failed: 0, dry_run: 0 };
    for (const r of rows) out[r.status] = r.n;
    return out;
  }

  // ---- users ------------------------------------------------------------

  getUser(id: number): User | null {
    const r = this.db.prepare("SELECT * FROM users WHERE id = ?").get(id) as any;
    return r ? toUser(r) : null;
  }

  usersWithWallets(): User[] {
    return (this.db.prepare("SELECT * FROM users WHERE wallet IS NOT NULL").all() as any[]).map(toUser);
  }

  usersWithAlerts(): User[] {
    return (this.db.prepare("SELECT * FROM users WHERE alerts_on = 1").all() as any[]).map(toUser);
  }

  getPref(userId: number, key: string): string | null {
    const r = this.db.prepare("SELECT value FROM prefs WHERE user_id = ? AND key = ?").get(userId, key) as any;
    return r?.value ?? null;
  }

  // ---- holdings ---------------------------------------------------------

  openHoldings(userId: number): Holding[] {
    return (
      this.db.prepare("SELECT * FROM holdings WHERE user_id = ? AND closed_at IS NULL ORDER BY bought_at").all(userId) as any[]
    ).map(toHolding);
  }

  getHolding(id: string): Holding | null {
    const r = this.db.prepare("SELECT * FROM holdings WHERE id = ?").get(id) as any;
    return r ? toHolding(r) : null;
  }

  spentSince(userId: number, since: Date): number {
    const r = this.db
      .prepare("SELECT COALESCE(SUM(cost_usd), 0) s FROM holdings WHERE user_id = ? AND bought_at >= ?")
      .get(userId, since.toISOString()) as { s: number };
    return r.s;
  }

  addPendingReason(holdingId: string, userId: number) {
    this.db
      .prepare("INSERT OR IGNORE INTO pending_reasons (holding_id, user_id, asked_at) VALUES (?, ?, ?)")
      .run(holdingId, userId, new Date().toISOString());
  }

  /** Oldest buy still waiting for the user to say why. */
  nextPendingReason(userId: number): Holding | null {
    const r = this.db
      .prepare(
        `SELECT h.* FROM pending_reasons p JOIN holdings h ON h.id = p.holding_id
         WHERE p.user_id = ? AND h.closed_at IS NULL ORDER BY p.asked_at LIMIT 1`,
      )
      .get(userId) as any;
    return r ? toHolding(r) : null;
  }

  // ---- snapshots --------------------------------------------------------

  getSnapshot(userId: number): Balance[] | null {
    const r = this.db.prepare("SELECT balances FROM snapshots WHERE user_id = ?").get(userId) as any;
    return r ? (JSON.parse(r.balances) as Balance[]) : null;
  }

  setSnapshot(userId: number, balances: Balance[]) {
    this.db
      .prepare("INSERT INTO snapshots (user_id, balances, at) VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET balances = excluded.balances, at = excluded.at")
      .run(userId, JSON.stringify(balances), new Date().toISOString());
  }

  clearSnapshot(userId: number) {
    this.db.prepare("DELETE FROM snapshots WHERE user_id = ?").run(userId);
  }

  // ---- alerts -----------------------------------------------------------

  getAlert(id: string): Alert | null {
    const r = this.db.prepare("SELECT * FROM alerts WHERE id = ?").get(id) as any;
    return r ? toAlert(r) : null;
  }

  /** Alerts sent before the cutoff with no outcome yet. */
  alertsAwaitingOutcome(sentBefore: Date): Alert[] {
    return (
      this.db.prepare("SELECT * FROM alerts WHERE change_pct IS NULL AND sent_at <= ?").all(sentBefore.toISOString()) as any[]
    ).map(toAlert);
  }

  /** Resolved outcomes for the track record: alerts the user bought, oldest first. Falls back to all alerts. */
  outcomes(userId: number, tokenClass: TokenClass): boolean[] {
    const bought = this.db
      .prepare(
        "SELECT change_pct FROM alerts WHERE user_id = ? AND token_class = ? AND change_pct IS NOT NULL AND action = 'bought' ORDER BY sent_at",
      )
      .all(userId, tokenClass) as { change_pct: number }[];
    if (bought.length >= 5) return bought.map((r) => r.change_pct > 0);
    const all = this.db
      .prepare("SELECT change_pct FROM alerts WHERE user_id = ? AND token_class = ? AND change_pct IS NOT NULL ORDER BY sent_at")
      .all(userId, tokenClass) as { change_pct: number }[];
    return all.map((r) => r.change_pct > 0);
  }

  /** Shared win rate across every user's alerts for a token class. */
  sharedWinRate(tokenClass: TokenClass): { wins: number; total: number } {
    const r = this.db
      .prepare("SELECT COUNT(*) total, SUM(CASE WHEN change_pct > 0 THEN 1 ELSE 0 END) wins FROM token_outcomes WHERE token_class = ?")
      .get(tokenClass) as { total: number; wins: number | null };
    return { wins: r.wins ?? 0, total: r.total };
  }

  recentAlertCount(userId: number, since: Date): number {
    const r = this.db.prepare("SELECT COUNT(*) n FROM alerts WHERE user_id = ? AND sent_at >= ?").get(userId, since.toISOString()) as {
      n: number;
    };
    return r.n;
  }

  poolOnCooldown(poolAddress: string, within: number): boolean {
    const r = this.db.prepare("SELECT alerted_at FROM pool_cooldown WHERE pool_address = ?").get(poolAddress) as any;
    return !!r && Date.now() - Date.parse(r.alerted_at) < within;
  }

  markPoolAlerted(poolAddress: string) {
    this.db
      .prepare("INSERT INTO pool_cooldown (pool_address, alerted_at) VALUES (?, ?) ON CONFLICT(pool_address) DO UPDATE SET alerted_at = excluded.alerted_at")
      .run(poolAddress, new Date().toISOString());
  }

  eventCount(namespace: string): number {
    return (this.db.prepare("SELECT COUNT(*) n FROM events WHERE namespace = ?").get(namespace) as { n: number }).n;
  }
}

function toUser(r: any): User {
  return {
    id: r.id,
    chatId: r.chat_id,
    wallet: r.wallet,
    budgetUsd: r.budget_usd,
    baseShare: r.base_share,
    alertsOn: !!r.alerts_on,
  };
}

function toHolding(r: any): Holding {
  return {
    id: r.id,
    userId: r.user_id,
    coinType: r.coin_type,
    symbol: r.symbol,
    units: r.units,
    costUsd: r.cost_usd,
    entryPriceUsd: r.entry_price_usd,
    entryVolumeH24Usd: r.entry_volume_h24_usd,
    reason: r.reason,
    boughtAt: r.bought_at,
    closedAt: r.closed_at,
  };
}

function toAlert(r: any): Alert {
  return {
    id: r.id,
    userId: r.user_id,
    poolAddress: r.pool_address,
    coinType: r.coin_type,
    symbol: r.symbol,
    tokenClass: r.token_class,
    priceUsd: r.price_usd,
    sizeUsd: r.size_usd,
    sentAt: r.sent_at,
    action: r.action,
    changePct: r.change_pct,
  };
}
