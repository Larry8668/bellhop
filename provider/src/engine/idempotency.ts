import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { ToolName } from '@bellhop/shared/contracts';

/** Deterministic key order so `{a:1,b:2}` and `{b:2,a:1}` fingerprint the same. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
    .join(',')}}`;
}

export function fingerprint(payload: unknown): string {
  return createHash('sha256').update(canonicalJson(payload)).digest('hex');
}

export interface IdempotencyRow {
  tool: ToolName;
  key: string;
  fingerprint: string;
  status: number;
  body_json: string;
}

export function getIdempotency(
  db: Database.Database,
  tool: ToolName,
  key: string,
): IdempotencyRow | undefined {
  return db
    .prepare('SELECT tool, key, fingerprint, status, body_json FROM idempotency WHERE tool = ? AND key = ?')
    .get(tool, key) as IdempotencyRow | undefined;
}

export function putIdempotency(
  db: Database.Database,
  tool: ToolName,
  key: string,
  fp: string,
  status: number,
  body: unknown,
): void {
  db.prepare(
    `INSERT INTO idempotency (tool, key, fingerprint, status, body_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(tool, key) DO UPDATE SET
       fingerprint = excluded.fingerprint,
       status = excluded.status,
       body_json = excluded.body_json`,
  ).run(tool, key, fp, status, JSON.stringify(body));
}

export function listIdempotency(
  db: Database.Database,
): { tool: ToolName; key: string; fingerprint: string; status: number }[] {
  const rows = db
    .prepare('SELECT tool, key, fingerprint, status FROM idempotency ORDER BY tool, key')
    .all() as IdempotencyRow[];
  return rows.map((r) => ({ tool: r.tool, key: r.key, fingerprint: r.fingerprint, status: r.status }));
}
