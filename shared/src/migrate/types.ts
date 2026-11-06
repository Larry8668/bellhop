import type Database from 'better-sqlite3';
import type { Clock } from '../clock.js';
import type { Logger } from '../logger.js';

export interface AppliedMigration {
  version: string;
  name: string;
  appliedAt: string;
}

export interface PendingMigration {
  version: string;
  name: string;
}

export interface MigrationStatus {
  applied: AppliedMigration[];
  pending: PendingMigration[];
}

export interface Migrator {
  /** Applies all pending migrations in version order, each in its own transaction. */
  up(): AppliedMigration[];
  /**
   * Reverts the most recently applied `steps` migrations (default 1), most
   * recent first. Refuses — throwing before touching the database — if any
   * migration in that range has no `-- migrate:down` section.
   */
  down(steps?: number): AppliedMigration[];
  status(): MigrationStatus;
  /** Reverts the reversible suffix of applied migrations, then re-applies everything (+ reseed, via `runMigrationCli`). */
  reset(): AppliedMigration[];
  /** Record migrations up to `version` as applied without running them (adopt an existing db). */
  stamp(version: string): AppliedMigration[];
}

export interface CreateMigratorDeps {
  db: Database.Database;
  /** Directory containing `NNNN_name.sql` migration files. */
  dir: string;
  logger: Logger;
  /** Defaults to the real clock; inject a fake one in tests that assert on `appliedAt`. */
  clock?: Clock;
}

/** A parsed migration file, loaded once when the migrator is created. */
export interface MigrationFile {
  version: string;
  name: string;
  file: string;
  upSql: string;
  downSql: string | null;
}
