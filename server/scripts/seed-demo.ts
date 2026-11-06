/**
 * Seeds the demo account (plan §14: "Seeded demo account") plus the Phase 4
 * memory set and a long prior conversation (plan §11). `seedDemo` is the
 * reusable part (used by both `npm run seed:demo` and `db:seed`); the
 * `main()` below is the standalone CLI entry point for `seed:demo`.
 * Idempotent: a second run does not duplicate the account, memories, or
 * messages.
 *
 * Env (CLI entry point only):
 *   DB_PATH             sqlite file path (default ./data/bellhop.db)
 *   BETTER_AUTH_SECRET  required in production; falls back to an insecure
 *                       dev default here with a printed warning
 *   BETTER_AUTH_URL     base URL Better Auth uses for links (default
 *                       http://localhost:3000; not reached during seeding)
 */
import type Database from 'better-sqlite3';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import { openSqlite } from '@bellhop/shared/sqlite';
import { migrateDb } from '../src/db/migrate.js';
import { createAuth, type Auth } from '../src/auth/auth.js';
import { seedDemoHistory } from './demo-history.js';

const DEMO_EMAIL = 'demo@bellhop.local';
const DEMO_PASSWORD = 'demo-pass-123';
const DEMO_NAME = 'Demo User';
const INSECURE_DEFAULT_SECRET = 'dev-secret-change-me';

/**
 * Creates the demo account if it doesn't already exist, then ensures that
 * user has 50+ memories and a long prior conversation. Both steps are
 * idempotent: a second run does not duplicate rows.
 */
export async function seedDemo(auth: Auth, logger: Logger, db: Database.Database): Promise<string> {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(DEMO_EMAIL);
  let userId: string;
  let accountMessage: string;
  if (existing) {
    userId = existing.user.id;
    logger.info({ email: DEMO_EMAIL, userId }, 'demo account already exists');
    accountMessage = `demo account already exists: ${DEMO_EMAIL} (id ${userId})`;
  } else {
    const result = await auth.api.signUpEmail({
      body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
    });
    userId = result.user.id;
    logger.info({ email: result.user.email, userId }, 'demo account created');
    accountMessage = `created demo account: ${result.user.email} (id ${userId})`;
  }

  const seeded = seedDemoHistory(db, userId, logger);
  return `${accountMessage}; memories=${seeded.memories}; messages=${seeded.messages}`;
}

async function main(): Promise<void> {
  const dbPath = process.env.DB_PATH ?? './data/bellhop.db';
  const baseUrl = process.env.BETTER_AUTH_URL ?? 'http://localhost:3000';

  let secret = process.env.BETTER_AUTH_SECRET;
  if (!secret) {
    console.warn(
      `BETTER_AUTH_SECRET is not set; using insecure default "${INSECURE_DEFAULT_SECRET}" (dev only, never use in production)`,
    );
    secret = INSECURE_DEFAULT_SECRET;
  }

  const logger = createLogger({ name: 'seed-demo', level: 'info' });
  const db = openSqlite(dbPath, { logger });
  const auth = createAuth({ db, secret, baseUrl, logger });

  migrateDb(db, logger);

  const message = await seedDemo(auth, logger, db);
  console.log(message);
  db.close();
}

// Only run the CLI body when this file is executed directly (`npm run
// seed:demo`), not when `scripts/db.ts` imports `seedDemo` for `db:seed`.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('seed-demo failed:', err);
    process.exitCode = 1;
  });
}
