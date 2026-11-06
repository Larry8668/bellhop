import type Database from 'better-sqlite3';

/** Small key/value helper over the `meta` table (seed, schema_version). */

export function getMeta(db: Database.Database, key: string): string | undefined {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value;
}

export function setMeta(db: Database.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}

export function getSeed(db: Database.Database): number {
  const raw = getMeta(db, 'seed');
  return raw !== undefined ? Number(raw) : 0;
}
