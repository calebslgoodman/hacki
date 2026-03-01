import Database from "better-sqlite3";
import path from "path";

const DB_PATH = path.join(__dirname, "contentpay.db");

export const db = new Database(DB_PATH);

// Enable WAL mode for better performance
db.pragma("journal_mode = WAL");

// ── Schema ────────────────────────────────────────────────────────────────────

db.exec(`
  CREATE TABLE IF NOT EXISTS wallets (
    id          TEXT PRIMARY KEY,
    owner_id    TEXT NOT NULL,
    owner_type  TEXT NOT NULL CHECK(owner_type IN ('user','creator','platform')),
    balance     REAL NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS users (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    api_key     TEXT UNIQUE NOT NULL,
    wallet_id   TEXT NOT NULL REFERENCES wallets(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS creators (
    id          TEXT PRIMARY KEY,
    name        TEXT NOT NULL,
    email       TEXT UNIQUE NOT NULL,
    api_key     TEXT UNIQUE NOT NULL,
    wallet_id   TEXT NOT NULL REFERENCES wallets(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS media (
    id          TEXT PRIMARY KEY,
    creator_id  TEXT NOT NULL REFERENCES creators(id),
    title       TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    price       REAL NOT NULL,
    content_url TEXT NOT NULL,
    thumbnail   TEXT NOT NULL DEFAULT '',
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    media_id    TEXT NOT NULL REFERENCES media(id),
    tx_id       TEXT NOT NULL REFERENCES transactions(id),
    purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, media_id)
  );

  CREATE TABLE IF NOT EXISTS transactions (
    id            TEXT PRIMARY KEY,
    from_wallet   TEXT NOT NULL,
    to_wallet     TEXT NOT NULL,
    amount        REAL NOT NULL,
    fee           REAL NOT NULL DEFAULT 0,
    media_id      TEXT,
    type          TEXT NOT NULL,
    timestamp     TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS checkout_sessions (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    media_id    TEXT NOT NULL,
    expires_at  TEXT NOT NULL,
    used        INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS user_sessions (
    token       TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL REFERENCES users(id),
    created_at  TEXT NOT NULL DEFAULT (datetime('now')),
    expires_at  TEXT NOT NULL
  );

`);

// ── Schema migrations (safe to run on existing DBs) ──────────────────────────

try { db.exec("ALTER TABLE media ADD COLUMN price_per_minute REAL"); } catch {}
try { db.exec("ALTER TABLE media ADD COLUMN billing_interval_seconds INTEGER DEFAULT 10"); } catch {}
try { db.exec("ALTER TABLE media ADD COLUMN initial_payment REAL DEFAULT 0"); } catch {}
try { db.exec("ALTER TABLE users ADD COLUMN solana_wallet TEXT"); } catch {}

db.exec(`
  CREATE TABLE IF NOT EXISTS solana_deposits (
    id           TEXT PRIMARY KEY,
    user_id      TEXT NOT NULL REFERENCES users(id),
    tx_signature TEXT UNIQUE NOT NULL,
    sol_amount   REAL NOT NULL,
    usd_credited REAL NOT NULL,
    sol_price    REAL NOT NULL,
    confirmed_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS timed_sessions (
    id             TEXT PRIMARY KEY,
    user_id        TEXT NOT NULL REFERENCES users(id),
    media_id       TEXT NOT NULL REFERENCES media(id),
    started_at     TEXT NOT NULL DEFAULT (datetime('now')),
    last_heartbeat TEXT NOT NULL DEFAULT (datetime('now')),
    total_charged  REAL NOT NULL DEFAULT 0,
    active         INTEGER NOT NULL DEFAULT 1
  );
`);

export default db;
