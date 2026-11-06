import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from './logger.js';

/**
 * Opens a SQLite file with the pragmas every connection in this repo needs
 * (provider and server each had their own copy of this before it moved
 * here): WAL for concurrent readers (skipped for `:memory:`, which has no
 * file to share), foreign keys enforced (SQLite defaults them off), and a
 * busy timeout so a brief writer lock waits instead of throwing.
 */
export function openSqlite(dbPath: string, deps: { logger: Logger }): Database.Database {
  const { logger } = deps;
  const isMemory = dbPath === ':memory:';

  if (!isMemory) {
    mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  if (!isMemory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  logger.debug({ path: dbPath, isMemory }, 'sqlite database opened');

  return db;
}
