import { mkdirSync } from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';

/**
 * Opens the provider's own SQLite file with the pragmas every connection
 * needs: WAL for concurrent readers (skipped for `:memory:`, which has no
 * file to share), foreign keys enforced, and a busy timeout so a brief
 * writer lock waits instead of throwing.
 */
export function openProviderDb(
  dbPath: string,
  deps: { logger: Logger },
): Database.Database {
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

  logger.debug({ path: dbPath, isMemory }, 'provider database opened');

  return db;
}
