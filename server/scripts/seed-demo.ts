/**
 * Seeds the demo account (plan §14: "Seeded demo account"). Not run by
 * vitest; invoke manually or via `npm run seed:demo`. Idempotent: skips
 * creation if the account already exists.
 *
 * Env:
 *   DB_PATH             sqlite file path (default ./data/bellhop.db)
 *   BETTER_AUTH_SECRET  required in production; falls back to an insecure
 *                       dev default here with a printed warning
 *   BETTER_AUTH_URL     base URL Better Auth uses for links (default
 *                       http://localhost:3000; not reached during seeding)
 */
import { createLogger } from '@bellhop/shared/logger';
import { openDatabase } from '../src/db/open.js';
import { createAuth } from '../src/auth/auth.js';
import { migrateAuth } from '../src/auth/migrate.js';

const DEMO_EMAIL = 'demo@bellhop.local';
const DEMO_PASSWORD = 'demo-pass-123';
const DEMO_NAME = 'Demo User';
const INSECURE_DEFAULT_SECRET = 'dev-secret-change-me';

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
  const db = openDatabase(dbPath, { logger });
  const auth = createAuth({ db, secret, baseUrl, logger });

  await migrateAuth(auth);

  const context = await auth.$context;
  const existing = await context.internalAdapter.findUserByEmail(DEMO_EMAIL);
  if (existing) {
    console.log(`Demo account already exists: ${DEMO_EMAIL} (id ${existing.user.id})`);
    db.close();
    return;
  }

  const result = await auth.api.signUpEmail({
    body: { email: DEMO_EMAIL, password: DEMO_PASSWORD, name: DEMO_NAME },
  });

  console.log(`Created demo account: ${result.user.email} (id ${result.user.id})`);
  db.close();
}

main().catch((err) => {
  console.error('seed-demo failed:', err);
  process.exit(1);
});
