import { systemClock } from '../clock.js';
import { childLogger } from '../logger.js';
import { loadMigrations } from './parse.js';
import type { AppliedMigration, CreateMigratorDeps, MigrationFile, Migrator } from './types.js';

function ensureMigrationsTable(db: CreateMigratorDeps['db']): void {
  // Bookkeeping table, not a tracked migration itself — created eagerly so
  // `status()`/`up()` work against an empty migrations dir too.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
}

interface AppliedRow {
  version: string;
  name: string;
  applied_at: string;
}

function toAppliedMigration(row: AppliedRow): AppliedMigration {
  return { version: row.version, name: row.name, appliedAt: row.applied_at };
}

export function createMigrator(deps: CreateMigratorDeps): Migrator {
  const { db, dir, logger, clock = systemClock } = deps;
  const log = childLogger(logger, 'migrate');
  const migrations = loadMigrations(dir);

  ensureMigrationsTable(db);

  const selectApplied = db.prepare('SELECT version, name, applied_at FROM schema_migrations ORDER BY version');
  const insertApplied = db.prepare('INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)');
  const deleteApplied = db.prepare('DELETE FROM schema_migrations WHERE version = ?');

  function appliedRows(): AppliedMigration[] {
    return (selectApplied.all() as AppliedRow[]).map(toAppliedMigration);
  }

  function findFile(version: string): MigrationFile {
    const file = migrations.find((m) => m.version === version);
    if (!file) {
      throw new Error(`migration ${version} is recorded as applied but its file is missing from ${dir}`);
    }
    return file;
  }

  function up(): AppliedMigration[] {
    const appliedVersions = new Set(appliedRows().map((a) => a.version));
    const pending = migrations.filter((m) => !appliedVersions.has(m.version));
    const result: AppliedMigration[] = [];

    for (const migration of pending) {
      const appliedAt = clock.now().toISOString();
      const label = `${migration.version}_${migration.name}`;

      // Each migration in its own transaction: a failing statement rolls
      // back only this migration's effects (including the ledger insert),
      // so a half-applied migration never looks "applied".
      const applyTxn = db.transaction(() => {
        db.exec(migration.upSql);
        insertApplied.run(migration.version, migration.name, appliedAt);
      });

      try {
        applyTxn();
      } catch (err) {
        log.error({ err, version: migration.version, name: migration.name }, 'migration failed, rolled back');
        throw new Error(`migration ${label} failed: ${(err as Error).message}`, { cause: err });
      }

      log.info({ version: migration.version, name: migration.name }, `applied ${label}`);
      result.push({ version: migration.version, name: migration.name, appliedAt });
    }

    return result;
  }

  function down(steps = 1): AppliedMigration[] {
    if (!Number.isInteger(steps) || steps < 1) {
      throw new Error(`down: steps must be a positive integer, got ${steps}`);
    }

    const toRevert = appliedRows()
      .sort((a, b) => b.version.localeCompare(a.version))
      .slice(0, steps);
    const result: AppliedMigration[] = [];

    for (const applied of toRevert) {
      const migration = findFile(applied.version);
      const label = `${migration.version}_${migration.name}`;
      if (migration.downSql === null) {
        throw new Error(`migration ${label} has no "-- migrate:down" section and cannot be reverted`);
      }

      const revertTxn = db.transaction(() => {
        db.exec(migration.downSql as string);
        deleteApplied.run(migration.version);
      });

      try {
        revertTxn();
      } catch (err) {
        log.error({ err, version: migration.version, name: migration.name }, 'revert failed, rolled back');
        throw new Error(`reverting migration ${label} failed: ${(err as Error).message}`, { cause: err });
      }

      log.info({ version: migration.version, name: migration.name }, `reverted ${label}`);
      result.push(applied);
    }

    return result;
  }

  /**
   * Mark migrations up to `version` as applied WITHOUT running them — for
   * adopting a database whose schema was created before the migration
   * files existed (alembic's `stamp`). Only the ledger is written.
   */
  function stamp(version: string): AppliedMigration[] {
    if (!migrations.some((m) => m.version === version)) {
      throw new Error(`stamp: no migration with version ${version} in ${dir}`);
    }
    const appliedVersions = new Set(appliedRows().map((a) => a.version));
    const toStamp = migrations.filter((m) => m.version <= version && !appliedVersions.has(m.version));
    const appliedAt = clock.now().toISOString();

    const stampTxn = db.transaction(() => {
      for (const m of toStamp) insertApplied.run(m.version, m.name, appliedAt);
    });
    stampTxn();

    for (const m of toStamp) log.info({ version: m.version, name: m.name }, `stamped ${m.version}_${m.name}`);
    return toStamp.map((m) => ({ version: m.version, name: m.name, appliedAt }));
  }

  function status() {
    const applied = appliedRows().sort((a, b) => a.version.localeCompare(b.version));
    const appliedVersions = new Set(applied.map((a) => a.version));
    const pending = migrations
      .filter((m) => !appliedVersions.has(m.version))
      .map((m) => ({ version: m.version, name: m.name }));
    return { applied, pending };
  }

  function reset(): AppliedMigration[] {
    // Only the reversible suffix of applied migrations (most-recent-first)
    // is rolled back: an irreversible migration anywhere in the applied
    // history stops the walk there, since nothing below it can be reverted
    // either. `up()` then reapplies whatever got reverted.
    const appliedDesc = appliedRows().sort((a, b) => b.version.localeCompare(a.version));
    let revertCount = 0;
    for (const applied of appliedDesc) {
      const migration = findFile(applied.version);
      if (migration.downSql === null) break;
      revertCount++;
    }
    if (revertCount > 0) down(revertCount);
    return up();
  }

  return { up, down, status, reset, stamp };
}
