/**
 * Migration CLI entry point: `tsx scripts/db.ts up|down [n]|status|reset|seed`.
 * Thin wrapper around `@bellhop/shared/migrate`'s `runMigrationCli` — this
 * file owns the only `console.*` calls (allowed in workspace `scripts/**`).
 */
import { createLogger } from '@bellhop/shared/logger';
import { openSqlite } from '@bellhop/shared/sqlite';
import { runMigrationCli } from '@bellhop/shared/migrate';
import { createSeededRng } from '@bellhop/shared/rng';
import { systemClock } from '@bellhop/shared/clock';
import type Database from 'better-sqlite3';
import { loadConfig } from '../src/config.js';
import { PROVIDER_MIGRATIONS_DIR } from '../src/db/schema.js';
import { getMeta } from '../src/db/meta.js';
import { seedProviders } from '../src/db/seed.js';

function seed(config: ReturnType<typeof loadConfig>): (db: Database.Database) => string {
  return (db) => {
    if (getMeta(db, 'seed') !== undefined) {
      return 'database already seeded — run `npm run db:reset -w provider` to reseed';
    }
    const rng = createSeededRng(config.SEED);
    seedProviders(db, { rng, clock: systemClock, seed: config.SEED });
    return `seeded with SEED=${config.SEED}`;
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ name: 'provider-db', level: config.LOG_LEVEL });
  const db = openSqlite(config.DB_PATH, { logger });

  const result = await runMigrationCli({
    argv: process.argv.slice(2),
    db,
    dir: PROVIDER_MIGRATIONS_DIR,
    seed: seed(config),
    logger,
  });

  for (const line of result.output) {
    console.log(line);
  }

  db.close();
  process.exitCode = result.exitCode;
}

main().catch((err) => {
  console.error('db command failed:', err);
  process.exitCode = 1;
});
