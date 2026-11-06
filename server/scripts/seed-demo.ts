/**
 * Seeds the demo account (plan §14: "Seeded demo account"). `seedDemo` is
 * the reusable part (used by both `npm run seed:demo` and `db:seed`); the
 * `main()` below is the standalone CLI entry point for `seed:demo`.
 * Idempotent: skips creation if the account already exists.
 *
 * Env (CLI entry point only):
 *   DB_PATH             sqlite file path (default ./data/bellhop.db)
 *   BETTER_AUTH_SECRET  required in production; falls back to an insecure
 *                       dev default here with a printed warning
 *   BETTER_AUTH_URL     base URL Better Auth uses for links (default
 *                       http://localhost:3000; not reached during seeding)
 */
import { createLogger, type Logger } from '@bellhop/shared/logger';
import { openSqlite } from '@bellhop/shared/sqlite';
import { migrateDb } from '../src/db/migrate.js';
import { createAuth, type Auth } from '../src/auth/auth.js';

const DEMO_EMAIL = 'demo@bellhop.local';
const DEMO_PASSWORD = 'demo-pass-123';
const DEMO_NAME = 'Demo User';
const INSECURE_DEFAULT_SECRET = 'dev-secret-change-me';

/** Creates the demo account if it doesn't already exist; returns a human-readable result message. */
export async function seedDemo(auth: Auth, logger: Logger): Promise<string> {
  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(DEMO_EMAIL);
  if (existing) {
    logger.info({ email: DEMO_EMAIL, userId: existing.user.id }, 'demo account already exists');
    return `demo account already exists: ${DEMO_EMAIL} (id ${existing.user.id})`;
  }

  const result = await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
  });

  logger.info({ email: result.user.email, userId: result.user.id }, 'demo account created');
  return `created demo account: ${result.user.email} (id ${result.user.id})`;
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

  const message = await seedDemo(auth, logger);
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
