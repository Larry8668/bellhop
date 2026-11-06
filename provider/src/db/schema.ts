import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createMigrator, type AppliedMigration } from '@bellhop/shared/migrate';
import type { Logger } from '@bellhop/shared/logger';

/**
 * Migration SQL lives outside `src/` (`provider/db/migrations`) so this same
 * relative path resolves correctly whether this module runs as
 * `src/db/schema.ts` under tsx or as compiled `dist/db/schema.js` after
 * `npm run build` — both sit exactly two directories below the package root.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const PROVIDER_MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'db', 'migrations');

/** Applies any pending migrations; safe to call on every boot and in every test setup. */
export function applySchema(db: Database.Database, logger: Logger): AppliedMigration[] {
  return createMigrator({ db, dir: PROVIDER_MIGRATIONS_DIR, logger }).up();
}

/**
 * Full wipe used by `admin.reset` before reseeding (plan §4's admin API,
 * distinct from the `db:reset` migration-CLI command). Children before
 * parents so this is safe with `foreign_keys = ON`. Deliberately row-level
 * `DELETE`, not drop/recreate: `admin.reset` must stay fast and in-process
 * for tests, not re-run migrations.
 */
export function resetAllTables(db: Database.Database): void {
  db.exec(`
    DELETE FROM idempotency;
    DELETE FROM events;
    DELETE FROM bookings;
    DELETE FROM holds;
    DELETE FROM reviews;
    DELETE FROM slots;
    DELETE FROM providers;
    DELETE FROM counters;
  `);
}
