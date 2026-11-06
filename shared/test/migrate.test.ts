import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger } from '../src/logger.js';
import { createMigrator } from '../src/migrate/index.js';

function writeMigration(dir: string, filename: string, contents: string): void {
  writeFileSync(path.join(dir, filename), contents);
}

function tables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[]).map(
    (r) => r.name,
  );
}

describe('createMigrator', () => {
  let dir: string;
  let db: Database.Database;
  const logger = createLogger({ name: 'test', level: 'silent' });

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bellhop-migrate-'));
    db = new Database(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  it('applies migrations in version order and is idempotent', () => {
    writeMigration(dir, '0002_second.sql', '-- migrate:up\nCREATE TABLE second (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE second;\n');
    writeMigration(dir, '0001_first.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE first;\n');

    const migrator = createMigrator({ db, dir, logger });
    const applied = migrator.up();

    expect(applied.map((a) => a.version)).toEqual(['0001', '0002']);
    expect(tables(db)).toEqual(expect.arrayContaining(['first', 'second']));

    const secondRun = migrator.up();
    expect(secondRun).toEqual([]);
  });

  it('status reports applied and pending migrations', () => {
    writeMigration(dir, '0001_first.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE first;\n');
    writeMigration(dir, '0002_second.sql', '-- migrate:up\nCREATE TABLE second (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE second;\n');

    const migrator = createMigrator({ db, dir, logger });

    const beforeStatus = migrator.status();
    expect(beforeStatus.applied).toEqual([]);
    expect(beforeStatus.pending.map((p) => p.version)).toEqual(['0001', '0002']);

    migrator.up();
    const afterStatus = migrator.status();
    expect(afterStatus.applied.map((a) => a.version)).toEqual(['0001', '0002']);
    expect(afterStatus.pending).toEqual([]);
  });

  it('down reverts the most recently applied migration and status reflects it', () => {
    writeMigration(dir, '0001_first.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE first;\n');
    writeMigration(dir, '0002_second.sql', '-- migrate:up\nCREATE TABLE second (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE second;\n');

    const migrator = createMigrator({ db, dir, logger });
    migrator.up();

    const reverted = migrator.down();
    expect(reverted.map((a) => a.version)).toEqual(['0002']);
    expect(tables(db)).not.toContain('second');
    expect(tables(db)).toContain('first');

    const status = migrator.status();
    expect(status.applied.map((a) => a.version)).toEqual(['0001']);
    expect(status.pending.map((p) => p.version)).toEqual(['0002']);
  });

  it('a migration with a syntax error leaves no partial table and is not recorded', () => {
    writeMigration(
      dir,
      '0001_broken.sql',
      '-- migrate:up\nCREATE TABLE ok_table (id TEXT PRIMARY KEY);\nCRATE TABLE typo (id TEXT);\n-- migrate:down\nDROP TABLE ok_table;\n',
    );

    const migrator = createMigrator({ db, dir, logger });

    expect(() => migrator.up()).toThrow(/0001_broken/);
    expect(tables(db)).not.toContain('ok_table');
    expect(migrator.status().applied).toEqual([]);
  });

  it('duplicate version files throw at load time', () => {
    writeMigration(dir, '0001_first.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n');
    writeMigration(dir, '0001_also_first.sql', '-- migrate:up\nCREATE TABLE also_first (id TEXT PRIMARY KEY);\n');

    expect(() => createMigrator({ db, dir, logger })).toThrow(/duplicate migration version "0001"/);
  });

  it('stamp records migrations up to a version without running them, and up() continues from there', () => {
    writeMigration(dir, '0001_first.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE first;\n');
    writeMigration(dir, '0002_second.sql', '-- migrate:up\nCREATE TABLE second (id TEXT PRIMARY KEY);\n-- migrate:down\nDROP TABLE second;\n');
    // A db whose schema pre-dates the migration files: `first` already exists.
    db.exec('CREATE TABLE first (id TEXT PRIMARY KEY);');
    const migrator = createMigrator({ db, dir, logger });

    expect(() => migrator.up()).toThrow(/0001_first failed/);
    expect(migrator.stamp('0001').map((a) => a.version)).toEqual(['0001']);
    expect(migrator.status().pending.map((p) => p.version)).toEqual(['0002']);
    expect(migrator.up().map((a) => a.version)).toEqual(['0002']);
    expect(migrator.stamp('0002')).toEqual([]);
    expect(() => migrator.stamp('9999')).toThrow(/no migration with version 9999/);
  });

  it('a migration with no "-- migrate:down" section refuses down', () => {
    writeMigration(dir, '0001_irreversible.sql', '-- migrate:up\nCREATE TABLE first (id TEXT PRIMARY KEY);\n');

    const migrator = createMigrator({ db, dir, logger });
    migrator.up();

    expect(() => migrator.down()).toThrow(/no "-- migrate:down" section/);
    expect(migrator.status().applied.map((a) => a.version)).toEqual(['0001']);
  });

  it('throws at load time on a bad filename', () => {
    writeMigration(dir, 'not-a-migration.sql', '-- migrate:up\nCREATE TABLE x (id TEXT);\n');
    expect(() => createMigrator({ db, dir, logger })).toThrow(/must match NNNN_name\.sql/);
  });

  it('throws at load time on a missing "-- migrate:up" section', () => {
    writeMigration(dir, '0001_no_up.sql', 'CREATE TABLE x (id TEXT);');
    expect(() => createMigrator({ db, dir, logger })).toThrow(/missing a "-- migrate:up" section/);
  });
});
