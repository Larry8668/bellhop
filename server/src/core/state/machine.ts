import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { TraceWriter } from '../../trace/writer.js';
import { createTaskStateRepo } from '../repo/task-state.repo.js';
import type { TaskState, TaskStateName } from '../types.js';

/**
 * Allowed edges (plan §6):
 *   GATHERING → SEARCHING → COMPARING → PROPOSED → APPROVED → EXECUTING → VERIFYING → DONE
 *   back-edges: APPROVED/EXECUTING/VERIFYING → PROPOSED (material change / hold expired / slot_taken)
 *   COMPARING → SEARCHING, PROPOSED → SEARCHING (user declines / alternatives)
 *   GATHERING → PROPOSED (cancel/reschedule skip the search, plan §6)
 *   any state → FAILED, any state → LIMIT_EXCEEDED
 *   DONE/FAILED/LIMIT_EXCEEDED → GATHERING (new errand)
 * No self-edges; nothing else is allowed.
 */
export const TRANSITIONS: Record<TaskStateName, readonly TaskStateName[]> = {
  GATHERING: ['SEARCHING', 'PROPOSED', 'FAILED', 'LIMIT_EXCEEDED'],
  SEARCHING: ['COMPARING', 'FAILED', 'LIMIT_EXCEEDED'],
  COMPARING: ['PROPOSED', 'SEARCHING', 'FAILED', 'LIMIT_EXCEEDED'],
  PROPOSED: ['APPROVED', 'SEARCHING', 'FAILED', 'LIMIT_EXCEEDED'],
  APPROVED: ['EXECUTING', 'PROPOSED', 'FAILED', 'LIMIT_EXCEEDED'],
  EXECUTING: ['VERIFYING', 'PROPOSED', 'FAILED', 'LIMIT_EXCEEDED'],
  VERIFYING: ['DONE', 'PROPOSED', 'FAILED', 'LIMIT_EXCEEDED'],
  DONE: ['GATHERING', 'FAILED', 'LIMIT_EXCEEDED'],
  FAILED: ['GATHERING', 'LIMIT_EXCEEDED'],
  LIMIT_EXCEEDED: ['GATHERING', 'FAILED'],
};

export class IllegalTransitionError extends Error {
  public readonly from: TaskStateName;
  public readonly to: TaskStateName;

  constructor(from: TaskStateName, to: TaskStateName) {
    super(`illegal state transition: ${from} -> ${to}`);
    this.name = 'IllegalTransitionError';
    this.from = from;
    this.to = to;
  }
}

/** Pure lookup against `TRANSITIONS` — no DB, no side effects. */
export function canTransition(from: TaskStateName, to: TaskStateName): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface StateMachineDeps {
  db: Database.Database;
  clock: Clock;
  trace: TraceWriter;
  logger: Logger;
}

export interface StateMachine {
  /**
   * Reads the current state (a missing `task_state` row counts as
   * `GATHERING`), throws `IllegalTransitionError` and leaves the row
   * untouched if `to` isn't reachable from the current state, otherwise
   * persists `state`/`updated_at`, emits a `state_transition` trace event,
   * and logs at info (plan §6: "every transition traced").
   */
  transition(userId: string, to: TaskStateName, reason?: string): TaskState;
}

export function createStateMachine(deps: StateMachineDeps): StateMachine {
  const { db, clock, trace, logger } = deps;
  const log = childLogger(logger, 'state-machine');
  const taskStateRepo = createTaskStateRepo(db);

  function transition(userId: string, to: TaskStateName, reason?: string): TaskState {
    const current = taskStateRepo.get(userId);
    const from: TaskStateName = current?.state ?? 'GATHERING';

    if (!canTransition(from, to)) {
      log.warn({ userId, from, to, reason }, 'illegal state transition rejected');
      throw new IllegalTransitionError(from, to);
    }

    const updatedAt = clock.now().toISOString();
    const next = taskStateRepo.setState(userId, to, updatedAt);

    trace.emit(
      reason === undefined ? { type: 'state_transition', from, to } : { type: 'state_transition', from, to, reason },
    );
    log.info({ userId, from, to, reason }, 'state transition');

    return next;
  }

  return { transition };
}
