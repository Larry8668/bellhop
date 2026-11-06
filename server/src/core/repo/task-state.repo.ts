import type Database from 'better-sqlite3';
import type { Service } from '@bellhop/shared/contracts';
import { TaskStateSchema, type TaskState, type TaskStateName, type TaskStatePrefs } from '../types.js';

interface TaskStateRow {
  user_id: string;
  conversation_id: string | null;
  state: TaskStateName;
  service: Service | null;
  area: string | null;
  window_from: string | null;
  window_to: string | null;
  budget: number | null;
  prefs_json: string;
  run_id: string | null;
  updated_at: string;
}

function toDomain(row: TaskStateRow): TaskState {
  return TaskStateSchema.parse({
    user_id: row.user_id,
    conversation_id: row.conversation_id,
    state: row.state,
    service: row.service,
    area: row.area,
    window_from: row.window_from,
    window_to: row.window_to,
    budget: row.budget,
    prefs: JSON.parse(row.prefs_json) as TaskStatePrefs,
    run_id: row.run_id,
    updated_at: row.updated_at,
  });
}

/**
 * Partial update — only the given fields change, the rest keep their
 * current value (plan §6: "a correction updates only the corrected
 * field"). `updated_at` is always required: core never calls `Date.now()`
 * itself, so every write takes the caller's injected-clock timestamp.
 */
export type TaskStatePatch = Partial<
  Pick<
    TaskState,
    'conversation_id' | 'state' | 'service' | 'area' | 'window_from' | 'window_to' | 'budget' | 'prefs' | 'run_id'
  >
> & { updated_at: string };

const DEFAULT_STATE: TaskStateName = 'GATHERING';

export interface TaskStateRepo {
  get(userId: string): TaskState | undefined;
  upsert(userId: string, patch: TaskStatePatch): TaskState;
  setState(userId: string, state: TaskStateName, updatedAt: string): TaskState;
}

export function createTaskStateRepo(db: Database.Database): TaskStateRepo {
  const selectStmt = db.prepare('SELECT * FROM task_state WHERE user_id = ?');
  const upsertStmt = db.prepare(`
    INSERT INTO task_state (
      user_id, conversation_id, state, service, area, window_from, window_to, budget, prefs_json, run_id, updated_at
    ) VALUES (@user_id, @conversation_id, @state, @service, @area, @window_from, @window_to, @budget, @prefs_json, @run_id, @updated_at)
    ON CONFLICT (user_id) DO UPDATE SET
      conversation_id = excluded.conversation_id,
      state = excluded.state,
      service = excluded.service,
      area = excluded.area,
      window_from = excluded.window_from,
      window_to = excluded.window_to,
      budget = excluded.budget,
      prefs_json = excluded.prefs_json,
      run_id = excluded.run_id,
      updated_at = excluded.updated_at
  `);

  function get(userId: string): TaskState | undefined {
    const row = selectStmt.get(userId) as TaskStateRow | undefined;
    return row === undefined ? undefined : toDomain(row);
  }

  function upsert(userId: string, patch: TaskStatePatch): TaskState {
    const existing = get(userId);
    const merged: TaskState = {
      user_id: userId,
      conversation_id: patch.conversation_id !== undefined ? patch.conversation_id : existing?.conversation_id ?? null,
      state: patch.state ?? existing?.state ?? DEFAULT_STATE,
      service: patch.service !== undefined ? patch.service : existing?.service ?? null,
      area: patch.area !== undefined ? patch.area : existing?.area ?? null,
      window_from: patch.window_from !== undefined ? patch.window_from : existing?.window_from ?? null,
      window_to: patch.window_to !== undefined ? patch.window_to : existing?.window_to ?? null,
      budget: patch.budget !== undefined ? patch.budget : existing?.budget ?? null,
      prefs: patch.prefs ?? existing?.prefs ?? {},
      run_id: patch.run_id !== undefined ? patch.run_id : existing?.run_id ?? null,
      updated_at: patch.updated_at,
    };

    upsertStmt.run({
      user_id: merged.user_id,
      conversation_id: merged.conversation_id,
      state: merged.state,
      service: merged.service,
      area: merged.area,
      window_from: merged.window_from,
      window_to: merged.window_to,
      budget: merged.budget,
      prefs_json: JSON.stringify(merged.prefs),
      run_id: merged.run_id,
      updated_at: merged.updated_at,
    });

    return merged;
  }

  function setState(userId: string, state: TaskStateName, updatedAt: string): TaskState {
    return upsert(userId, { state, updated_at: updatedAt });
  }

  return { get, upsert, setState };
}
