import type Database from 'better-sqlite3';
import { getMeta, setMeta } from './meta.js';

const SCHEMA_VERSION = 1;

/** Idempotent DDL — safe to call on every boot and in every test setup. */
export function applySchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      service TEXT NOT NULL,
      area TEXT NOT NULL,
      price INTEGER NOT NULL,
      rating REAL NOT NULL,
      description TEXT NOT NULL,
      years_active INTEGER NOT NULL,
      attributes_json TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      author TEXT NOT NULL,
      rating INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS slots (
      provider_id TEXT NOT NULL REFERENCES providers(id),
      start TEXT NOT NULL,
      end TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('open', 'held', 'booked')),
      PRIMARY KEY (provider_id, start)
    );

    CREATE TABLE IF NOT EXISTS holds (
      hold_id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      user_id TEXT NOT NULL,
      slot_start TEXT NOT NULL,
      slot_end TEXT NOT NULL,
      price INTEGER NOT NULL,
      search_price INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('active', 'consumed', 'void'))
    );

    CREATE TABLE IF NOT EXISTS bookings (
      booking_id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      provider_id TEXT NOT NULL REFERENCES providers(id),
      slot_start TEXT NOT NULL,
      slot_end TEXT NOT NULL,
      price INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('confirmed', 'cancelled', 'rescheduled')),
      hold_id TEXT,
      idempotency_key TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS idempotency (
      tool TEXT NOT NULL,
      key TEXT NOT NULL,
      fingerprint TEXT NOT NULL,
      status INTEGER NOT NULL,
      body_json TEXT NOT NULL,
      PRIMARY KEY (tool, key)
    );

    CREATE TABLE IF NOT EXISTS counters (
      name TEXT PRIMARY KEY,
      value INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      booking_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      consumed INTEGER NOT NULL DEFAULT 0
    );
  `);

  if (getMeta(db, 'schema_version') === undefined) {
    setMeta(db, 'schema_version', String(SCHEMA_VERSION));
  }
}

/**
 * Full wipe used by `admin.reset` before reseeding. Children before
 * parents so this is safe with `foreign_keys = ON`.
 */
export function resetAllTables(db: Database.Database): void {
  db.exec(`
    DELETE FROM idempotency;
    DELETE FROM events;
    DELETE FROM bookings;
    DELETE FROM holds;
    DELETE FROM reviews;
    DELETE FROM slots;
    DELETE FROM providers;
    DELETE FROM counters;
  `);
}
