import { fileURLToPath } from 'node:url';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { createMigrator, type AppliedMigration } from '@bellhop/shared/migrate';
import type { Logger } from '@bellhop/shared/logger';

/**
 * Migration SQL lives outside `src/` (`server/db/migrations`), resolved
 * relative to the package root the same way `provider/src/db/schema.ts`
 * does — see that file's comment for why the relative path stays correct
 * under both tsx and a build.
 */
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const SERVER_MIGRATIONS_DIR = path.join(PACKAGE_ROOT, 'db', 'migrations');

/** Applies any pending migrations. Replaces the old Better-Auth-only `migrateAuth`. */
export function migrateDb(db: Database.Database, logger: Logger): AppliedMigration[] {
  return createMigrator({ db, dir: SERVER_MIGRATIONS_DIR, logger }).up();
}
