import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { MigrationFile } from './types.js';

/** `0001_init.sql`, `0012_add_apikey_index.sql` — dbmate-compatible naming. */
const FILENAME_RE = /^(\d{4})_([A-Za-z0-9][A-Za-z0-9_-]*)\.sql$/;
const UP_MARKER = '-- migrate:up';
const DOWN_MARKER = '-- migrate:down';

function isMarker(line: string, marker: string): boolean {
  return line.trim().toLowerCase() === marker;
}

/** Splits a migration file's content into its up/down sections (dbmate style). */
function parseSections(content: string, filename: string): { upSql: string; downSql: string | null } {
  const lines = content.split(/\r?\n/);
  const upIdx = lines.findIndex((line) => isMarker(line, UP_MARKER));
  if (upIdx === -1) {
    throw new Error(`migration "${filename}" is missing a "-- migrate:up" section`);
  }

  const downIdx = lines.findIndex((line) => isMarker(line, DOWN_MARKER));
  if (downIdx !== -1 && downIdx < upIdx) {
    throw new Error(`migration "${filename}" has "-- migrate:down" before "-- migrate:up"`);
  }

  const upLines = downIdx === -1 ? lines.slice(upIdx + 1) : lines.slice(upIdx + 1, downIdx);
  const upSql = upLines.join('\n').trim();
  if (upSql.length === 0) {
    throw new Error(`migration "${filename}" has an empty "-- migrate:up" section`);
  }

  const downSection = downIdx === -1 ? null : lines.slice(downIdx + 1).join('\n').trim();
  // A present-but-empty `-- migrate:down` section is still "no down" (not reversible).
  const downSql = downSection !== null && downSection.length > 0 ? downSection : null;

  return { upSql, downSql };
}

/**
 * Loads and parses every `NNNN_name.sql` file in `dir`, sorted by version.
 * Throws immediately on a bad filename, a duplicate version, or a missing
 * `-- migrate:up` section — migrations are loaded once, at `createMigrator`
 * time, so a bad file fails loudly before anything runs (plan: parse errors
 * throw at load time).
 */
export function loadMigrations(dir: string): MigrationFile[] {
  let entries: string[];
  try {
    entries = readdirSync(dir).filter((f) => f.endsWith('.sql'));
  } catch (err) {
    throw new Error(`cannot read migrations directory "${dir}": ${(err as Error).message}`, { cause: err });
  }

  const fileByVersion = new Map<string, string>();
  const migrations: MigrationFile[] = [];

  for (const file of entries.sort()) {
    const match = FILENAME_RE.exec(file);
    if (!match) {
      throw new Error(`migration filename "${file}" must match NNNN_name.sql (4-digit version)`);
    }
    const version = match[1] as string;
    const name = match[2] as string;

    const existingFile = fileByVersion.get(version);
    if (existingFile !== undefined) {
      throw new Error(`duplicate migration version "${version}": "${existingFile}" and "${file}"`);
    }
    fileByVersion.set(version, file);

    const content = readFileSync(path.join(dir, file), 'utf8');
    const { upSql, downSql } = parseSections(content, file);
    migrations.push({ version, name, file, upSql, downSql });
  }

  return migrations.sort((a, b) => a.version.localeCompare(b.version));
}
