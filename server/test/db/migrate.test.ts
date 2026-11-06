import { describe, expect, it } from 'vitest';
import { getMigrations } from 'better-auth/db/migration';
import { createLogger } from '@bellhop/shared/logger';
import { openDatabase } from '../../src/db/open.js';
import { buildOptions } from '../../src/auth/auth.js';
import { migrateDb } from '../../src/db/migrate.js';

describe('migrateDb', () => {
  it('creates the Better Auth tables and is safe to call twice', () => {
    const logger = createLogger({ name: 'test', level: 'silent' });
    const db = openDatabase(':memory:', { logger });

    const applied = migrateDb(db, logger);
    expect(applied.map((a) => a.name)).toEqual(['auth']);
    expect(migrateDb(db, logger)).toEqual([]);

    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = tables.map((t) => t.name);

    expect(tableNames).toEqual(expect.arrayContaining(['user', 'session', 'account', 'apikey', 'verification']));

    db.close();
  });

  /**
   * Schema-drift guard (plan: catch a Better Auth upgrade that changes its
   * tables). Our committed `0001_auth.sql` is a snapshot of what
   * `getMigrations` planned at generation time; if a later Better Auth
   * version would plan something different against the *same* `createAuth`
   * options, this fails loudly instead of silently drifting. Regenerate
   * with `npm run db:gen-auth -w server` and add a new migration on top.
   */
  it('matches what better-auth would plan from scratch (no pending create/add)', async () => {
    const logger = createLogger({ name: 'test', level: 'silent' });
    const db = openDatabase(':memory:', { logger });
    migrateDb(db, logger);

    const options = buildOptions({
      db,
      secret: 'test-secret-do-not-use-in-production',
      baseUrl: 'http://localhost:3000',
      logger,
    });
    const { toBeCreated, toBeAdded } = await getMigrations(options);

    expect(toBeCreated).toEqual([]);
    expect(toBeAdded).toEqual([]);

    db.close();
  });
});
