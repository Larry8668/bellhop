import type { Auth } from './auth.js';

/**
 * Creates Better Auth's own tables (`user`, `session`, `account`, `apikey`,
 * `verification`) against the database passed to `createAuth`.
 *
 * Confirmed against the installed better-auth 1.7.18: `auth.$context` is a
 * promise for the internal `AuthContext`; when `database` is a live
 * connection (not a pre-built adapter), `context/init.ts` overrides the base
 * `runMigrations` stub with one that diffs the expected schema and issues
 * `CREATE TABLE ... IF NOT EXISTS` / `ALTER TABLE ADD COLUMN` statements
 * (see `better-auth/dist/db/get-migration.mjs`) — safe to call on every
 * startup.
 */
export async function migrateAuth(auth: Auth): Promise<void> {
  const context = await auth.$context;
  await context.runMigrations();
}
