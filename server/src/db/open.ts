import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';

/**
 * Opens the backend SQLite file with the pragmas every connection needs
 * (plan §5): WAL for concurrent readers, foreign keys enforced (SQLite
 * defaults them off), and a busy timeout so a brief writer lock doesn't
 * throw instead of waiting.
 */
export function openDatabase(path_: string, deps: { logger: Logger }): Database.Database {
  const { logger } = deps;
  const isMemory = path_ === ':memory:';

  if (!isMemory) {
    mkdirSync(path.dirname(path_), { recursive: true });
  }

  const db = new Database(path_);

  if (!isMemory) {
    db.pragma('journal_mode = WAL');
  }
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');

  logger.debug({ path: path_, isMemory }, 'database opened');

  return db;
}
