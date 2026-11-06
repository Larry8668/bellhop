import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { TraceWriter } from '../../trace/writer.js';
import { createIntentsRepo } from '../repo/intents.repo.js';
import type { Action, Intent, IntentStatus } from '../types.js';

/** Plan §8: derived from the approval id, so a repeated confirmation maps to the same provider-side key. */
export function idempotencyKey(action: Action, approvalId: string): string {
  return `${action}_${approvalId}`;
}

export interface IntentServiceDeps {
  db: Database.Database;
  clock: Clock;
  trace: TraceWriter;
  logger: Logger;
}

export interface IntentService {
  /** Writes the `pending` row before any provider call (plan §8); returns the existing row when the key is already taken. */
  begin(userId: string, approvalId: string, action: Action): { intent: Intent; created: boolean };
  get(key: string): Intent | undefined;
  succeed(key: string, result: unknown): Intent;
  fail(key: string, result: unknown): Intent;
  unknown(key: string): Intent;
  /** Counts one provider attempt (book/cancel/reschedule call, not a status check). */
  attempt(key: string): Intent;
}

export class IntentNotFoundError extends Error {
  public readonly key: string;

  constructor(key: string) {
    super(`intent not found: ${key}`);
    this.name = 'IntentNotFoundError';
    this.key = key;
  }
}

export function createIntentService(deps: IntentServiceDeps): IntentService {
  const { db, clock, trace, logger } = deps;
  const log = childLogger(logger, 'intents');
  const repo = createIntentsRepo(db);

  function mustGet(key: string): Intent {
    const intent = repo.get(key);
    if (intent === undefined) throw new IntentNotFoundError(key);
    return intent;
  }

  function setStatus(key: string, status: IntentStatus, result?: unknown): Intent {
    repo.setStatus(key, status, clock.now().toISOString(), result);
    const intent = mustGet(key);
    trace.emit({ type: 'intent', idempotency_key: key, action: intent.action, status });
    log.info({ idempotency_key: key, userId: intent.user_id, status }, 'intent status');
    return intent;
  }

  return {
    begin(userId, approvalId, action) {
      const key = idempotencyKey(action, approvalId);
      const now = clock.now().toISOString();
      const { created } = repo.insertPending({
        idempotency_key: key,
        approval_id: approvalId,
        user_id: userId,
        action,
        created_at: now,
        updated_at: now,
      });
      const intent = mustGet(key);
      if (created) {
        trace.emit({ type: 'intent', idempotency_key: key, action, status: 'pending' });
        log.info({ idempotency_key: key, userId, approvalId }, 'intent created');
      } else {
        log.info({ idempotency_key: key, userId, status: intent.status }, 'intent already exists');
      }
      return { intent, created };
    },

    get: (key) => repo.get(key),

    succeed: (key, result) => setStatus(key, 'succeeded', result),
    fail: (key, result) => setStatus(key, 'failed', result),
    unknown: (key) => setStatus(key, 'unknown'),

    attempt(key) {
      repo.incrementAttempts(key, clock.now().toISOString());
      return mustGet(key);
    },
  };
}
