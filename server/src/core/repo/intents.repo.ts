import type Database from 'better-sqlite3';
import { IntentSchema, type Action, type Intent, type IntentStatus } from '../types.js';

interface IntentRow {
  idempotency_key: string;
  approval_id: string;
  user_id: string;
  action: Action;
  status: IntentStatus;
  result_json: string | null;
  attempts: number;
  created_at: string;
  updated_at: string;
}

function toDomain(row: IntentRow): Intent {
  return IntentSchema.parse({
    idempotency_key: row.idempotency_key,
    approval_id: row.approval_id,
    user_id: row.user_id,
    action: row.action,
    status: row.status,
    result: row.result_json === null ? null : (JSON.parse(row.result_json) as unknown),
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export interface NewIntent {
  idempotency_key: string;
  approval_id: string;
  user_id: string;
  action: Action;
  created_at: string;
  updated_at: string;
}

export interface IntentsRepo {
  /** `INSERT OR IGNORE` on the `idempotency_key` PK: a repeated confirmation maps to the same key, so the second call must leave the first row untouched (plan §8). */
  insertPending(intent: NewIntent): { created: boolean };
  get(key: string): Intent | undefined;
  /**
   * `updatedAt` (and `result`) aren't in the plan's literal signature, but
   * core never calls `Date.now()`, so the caller's injected-clock
   * timestamp has to come in as a parameter.
   */
  setStatus(key: string, status: IntentStatus, updatedAt: string, result?: unknown): void;
  incrementAttempts(key: string, updatedAt: string): void;
  /** Pending/unknown intents across all users — startup recovery resolves these via `get_booking_status` before accepting turns (plan §8). */
  listUnresolved(): Intent[];
  listByUser(userId: string): Intent[];
}

export function createIntentsRepo(db: Database.Database): IntentsRepo {
  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO intents (idempotency_key, approval_id, user_id, action, status, result_json, attempts, created_at, updated_at)
    VALUES (@idempotency_key, @approval_id, @user_id, @action, 'pending', NULL, 0, @created_at, @updated_at)
  `);
  const selectStmt = db.prepare('SELECT * FROM intents WHERE idempotency_key = ?');
  const setStatusWithResultStmt = db.prepare(
    'UPDATE intents SET status = ?, result_json = ?, updated_at = ? WHERE idempotency_key = ?',
  );
  const setStatusStmt = db.prepare('UPDATE intents SET status = ?, updated_at = ? WHERE idempotency_key = ?');
  const incrementAttemptsStmt = db.prepare(
    'UPDATE intents SET attempts = attempts + 1, updated_at = ? WHERE idempotency_key = ?',
  );
  const listUnresolvedStmt = db.prepare(
    `SELECT * FROM intents WHERE status IN ('pending', 'unknown') ORDER BY created_at ASC`,
  );
  const listByUserStmt = db.prepare('SELECT * FROM intents WHERE user_id = ? ORDER BY created_at ASC');

  return {
    insertPending(intent: NewIntent): { created: boolean } {
      const result = insertStmt.run(intent);
      return { created: result.changes === 1 };
    },

    get(key: string): Intent | undefined {
      const row = selectStmt.get(key) as IntentRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },

    setStatus(key: string, status: IntentStatus, updatedAt: string, result?: unknown): void {
      if (result === undefined) {
        setStatusStmt.run(status, updatedAt, key);
      } else {
        setStatusWithResultStmt.run(status, JSON.stringify(result), updatedAt, key);
      }
    },

    incrementAttempts(key: string, updatedAt: string): void {
      incrementAttemptsStmt.run(updatedAt, key);
    },

    listUnresolved(): Intent[] {
      return (listUnresolvedStmt.all() as IntentRow[]).map(toDomain);
    },

    listByUser(userId: string): Intent[] {
      return (listByUserStmt.all(userId) as IntentRow[]).map(toDomain);
    },
  };
}
