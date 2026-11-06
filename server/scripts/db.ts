/**
 * Migration CLI entry point: `tsx scripts/db.ts up|down [n]|status|reset|seed`.
 * Thin wrapper around `@bellhop/shared/migrate`'s `runMigrationCli` — this
 * file owns the only `console.*` calls (allowed in workspace `scripts/**`).
 */
import { createLogger } from '@bellhop/shared/logger';
import { openSqlite } from '@bellhop/shared/sqlite';
import { runMigrationCli } from '@bellhop/shared/migrate';
import { loadConfig } from '../src/config.js';
import { createAuth } from '../src/auth/auth.js';
import { SERVER_MIGRATIONS_DIR } from '../src/db/migrate.js';
import { seedDemo } from './seed-demo.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ name: 'server-db', level: config.LOG_LEVEL });
  const db = openSqlite(config.DB_PATH, { logger });

  const auth = createAuth({
    db,
    secret: config.BETTER_AUTH_SECRET,
    baseUrl: config.BETTER_AUTH_URL,
    trustedOrigins: [config.WEB_ORIGIN],
    logger,
  });

  const result = await runMigrationCli({
    argv: process.argv.slice(2),
    db,
    dir: SERVER_MIGRATIONS_DIR,
    seed: () => seedDemo(auth, logger, db),
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
