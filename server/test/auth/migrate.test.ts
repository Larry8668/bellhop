import { describe, expect, it } from 'vitest';
import { createLogger } from '@bellhop/shared/logger';
import { openDatabase } from '../../src/db/open.js';
import { createAuth } from '../../src/auth/auth.js';
import { migrateAuth } from '../../src/auth/migrate.js';

describe('migrateAuth', () => {
  it('creates the Better Auth tables and is safe to call twice', async () => {
    const logger = createLogger({ name: 'test', level: 'silent' });
    const db = openDatabase(':memory:', { logger });
    const auth = createAuth({ db, secret: 'test-secret-do-not-use-in-production', baseUrl: 'http://localhost:3000', logger });

    await migrateAuth(auth);
    await expect(migrateAuth(auth)).resolves.toBeUndefined();

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toEqual(expect.arrayContaining(['user', 'session', 'account', 'apikey', 'verification']));

    db.close();
  });
});
