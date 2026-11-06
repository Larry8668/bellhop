import type Database from 'better-sqlite3';
import { createLogger } from '@bellhop/shared/logger';
import { openDatabase } from '../../src/db/open.js';
import { migrateDb } from '../../src/db/migrate.js';

export const TEST_USER = 'user_1';
export const OTHER_USER = 'user_2';

/** Fresh in-memory DB with every migration applied (plan §5 tables + Better Auth's). */
export function createTestDb(): Database.Database {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const db = openDatabase(':memory:', { logger });
  migrateDb(db, logger);
  return db;
}
