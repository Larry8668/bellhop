import type Database from 'better-sqlite3';

export type IdPrefix = 'prv' | 'hold' | 'bk';

/** Readable sequential ids (`prv_1`, `hold_1`, `bk_1`) backed by `counters`. */
export function nextId(db: Database.Database, prefix: IdPrefix): string {
  const row = db.prepare('SELECT value FROM counters WHERE name = ?').get(prefix) as
    | { value: number }
    | undefined;
  const next = (row?.value ?? 0) + 1;
  db.prepare(
    `INSERT INTO counters (name, value) VALUES (?, ?)
     ON CONFLICT(name) DO UPDATE SET value = excluded.value`,
  ).run(prefix, next);
  return `${prefix}_${next}`;
}
