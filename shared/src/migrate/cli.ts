import type Database from 'better-sqlite3';
import type { Logger } from '../logger.js';
import { createMigrator } from './migrator.js';
import type { AppliedMigration, PendingMigration } from './types.js';

export interface RunMigrationCliDeps {
  argv: string[];
  db: Database.Database;
  dir: string;
  logger: Logger;
  /** Workspace-specific seeding. Return a string to surface a custom message (e.g. "already seeded"). */
  seed?: (db: Database.Database) => Promise<string | void> | string | void;
}

export interface MigrationCliResult {
  /** Lines for the caller to print. `no-console` is only relaxed for workspace `scripts/**` entry files, not this shared module, so printing happens there. */
  output: string[];
  exitCode: number;
}

const USAGE = 'usage: <up|down [n]|status|reset|seed|stamp <version>>';

function formatStatusTable(applied: AppliedMigration[], pending: PendingMigration[]): string[] {
  const rows = [
    ...applied.map((a) => ({ version: a.version, name: a.name, status: 'applied', appliedAt: a.appliedAt })),
    ...pending.map((p) => ({ version: p.version, name: p.name, status: 'pending', appliedAt: '-' })),
  ].sort((a, b) => a.version.localeCompare(b.version));

  if (rows.length === 0) {
    return ['no migrations found'];
  }

  const widths = {
    version: Math.max('version'.length, ...rows.map((r) => r.version.length)),
    name: Math.max('name'.length, ...rows.map((r) => r.name.length)),
    status: Math.max('status'.length, ...rows.map((r) => r.status.length)),
  };

  const header = `${'version'.padEnd(widths.version)}  ${'name'.padEnd(widths.name)}  ${'status'.padEnd(widths.status)}  applied_at`;
  const lines = rows.map(
    (r) =>
      `${r.version.padEnd(widths.version)}  ${r.name.padEnd(widths.name)}  ${r.status.padEnd(widths.status)}  ${r.appliedAt}`,
  );

  return [header, ...lines, `${applied.length} applied, ${pending.length} pending`];
}

async function runSeed(db: Database.Database, seed: RunMigrationCliDeps['seed']): Promise<MigrationCliResult> {
  if (!seed) {
    return { output: ['no seed function configured for this workspace'], exitCode: 1 };
  }
  const message = await seed(db);
  return { output: [typeof message === 'string' ? message : 'seed complete'], exitCode: 0 };
}

/**
 * Shared body for the per-workspace `scripts/db.ts up|down|status|reset|seed`
 * CLI (provider and server each have a thin entry file that calls this and
 * prints `result.output`).
 */
export async function runMigrationCli(deps: RunMigrationCliDeps): Promise<MigrationCliResult> {
  const { argv, db, dir, logger, seed } = deps;
  const [command, ...rest] = argv;

  const migrator = createMigrator({ db, dir, logger });

  switch (command) {
    case 'up': {
      const applied = migrator.up();
      return {
        output: applied.length === 0 ? ['no pending migrations'] : applied.map((a) => `applied ${a.version}_${a.name}`),
        exitCode: 0,
      };
    }
    case 'down': {
      const stepsArg = rest[0];
      const steps = stepsArg === undefined ? 1 : Number(stepsArg);
      if (!Number.isInteger(steps) || steps < 1) {
        return { output: [`invalid step count: "${stepsArg}"`], exitCode: 1 };
      }
      const reverted = migrator.down(steps);
      return {
        output: reverted.length === 0 ? ['nothing to revert'] : reverted.map((a) => `reverted ${a.version}_${a.name}`),
        exitCode: 0,
      };
    }
    case 'status': {
      const { applied, pending } = migrator.status();
      return { output: formatStatusTable(applied, pending), exitCode: 0 };
    }
    case 'seed':
      return runSeed(db, seed);
    case 'stamp': {
      const version = rest[0];
      if (!version) {
        return { output: [USAGE, 'stamp requires a version, e.g. stamp 0001'], exitCode: 1 };
      }
      const stamped = migrator.stamp(version);
      return {
        output: stamped.length === 0 ? ['nothing to stamp'] : stamped.map((a) => `stamped ${a.version}_${a.name}`),
        exitCode: 0,
      };
    }
    case 'reset': {
      migrator.reset();
      const seedResult = await runSeed(db, seed);
      return { output: ['reset complete', ...seedResult.output], exitCode: seedResult.exitCode };
    }
    default:
      return { output: [USAGE, `unknown command: "${command ?? ''}"`], exitCode: 1 };
  }
}
