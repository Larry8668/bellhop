import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { FactKind, FactStatus } from './types.js';

const FactKindSchema = z.enum(['explicit', 'inferred']);
const FactStatusSchema = z.enum(['active', 'unconfirmed', 'forgotten']);

export interface StoredMemory {
  id: string;
  userId: string;
  key: string;
  value: string;
  kind: FactKind;
  status: FactStatus;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

export interface MemoryPatch {
  value: string;
  kind: FactKind;
  status: FactStatus;
  tags: string[];
  updatedAt: string;
}

export interface StoredContextLog {
  id: string;
  userId: string;
  runId: string;
  step: number;
  estTokens: number;
  actualTokensIn: number | null;
  actualTokensOut: number | null;
  factIds: string[];
  sections: Record<string, number>;
  createdAt: string;
}

const StoredMemorySchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  kind: FactKindSchema,
  status: FactStatusSchema,
  tags: z.array(z.string()),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
});

const StoredContextLogSchema = z.object({
  id: z.string().min(1),
  userId: z.string().min(1),
  runId: z.string().min(1),
  step: z.number().int().nonnegative(),
  estTokens: z.number().int().nonnegative(),
  actualTokensIn: z.number().int().nonnegative().nullable(),
  actualTokensOut: z.number().int().nonnegative().nullable(),
  factIds: z.array(z.string()),
  sections: z.record(z.string(), z.number()),
  createdAt: z.string().min(1),
});

interface MemorySqlRow {
  id: string;
  user_id: string;
  key: string;
  value: string;
  kind: string;
  status: string;
  tags_json: string;
  created_at: string;
  updated_at: string;
}

interface ContextSqlRow {
  id: string;
  user_id: string;
  run_id: string;
  step: number;
  est_tokens: number;
  actual_tokens_in: number | null;
  actual_tokens_out: number | null;
  fact_ids_json: string;
  sections_json: string;
  created_at: string;
}

function parseJsonColumn(text: string, column: string, id: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    throw new Error(`${column} is not valid JSON for ${id}`, { cause: err });
  }
}

function toMemory(row: MemorySqlRow): StoredMemory {
  return StoredMemorySchema.parse({
    id: row.id,
    userId: row.user_id,
    key: row.key,
    value: row.value,
    kind: row.kind,
    status: row.status,
    tags: parseJsonColumn(row.tags_json, 'memories.tags_json', row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
}

function toContext(row: ContextSqlRow): StoredContextLog {
  return StoredContextLogSchema.parse({
    id: row.id,
    userId: row.user_id,
    runId: row.run_id,
    step: row.step,
    estTokens: row.est_tokens,
    actualTokensIn: row.actual_tokens_in,
    actualTokensOut: row.actual_tokens_out,
    factIds: parseJsonColumn(row.fact_ids_json, 'context_log.fact_ids_json', row.id),
    sections: parseJsonColumn(row.sections_json, 'context_log.sections_json', row.id),
    createdAt: row.created_at,
  });
}

export interface MemoryRepo {
  transaction<T>(fn: () => T): T;
  insert(memory: StoredMemory): void;
  getById(userId: string, id: string): StoredMemory | undefined;
  /** Newest first (`updated_at` desc, then `id` desc). */
  list(userId: string, statuses: FactStatus[]): StoredMemory[];
  listByKey(userId: string, key: string, statuses: FactStatus[]): StoredMemory[];
  getMany(userId: string, ids: readonly string[]): StoredMemory[];
  update(userId: string, id: string, patch: MemoryPatch): StoredMemory | undefined;
  /** Rows whose status actually changed. Already-forgotten rows are left alone. */
  forgetByKey(userId: string, key: string, updatedAt: string): number;
  forgetById(userId: string, id: string, updatedAt: string): boolean;
  insertContext(row: StoredContextLog): void;
  /** Oldest first. `runId` omitted returns every run for the user. */
  listContext(userId: string, runId?: string): StoredContextLog[];
}

export function createMemoryRepo(db: Database.Database): MemoryRepo {
  const insertMemory = db.prepare(`
    INSERT INTO memories (id, user_id, key, value, kind, status, tags_json, created_at, updated_at)
    VALUES (@id, @user_id, @key, @value, @kind, @status, @tags_json, @created_at, @updated_at)
  `);
  const selectById = db.prepare('SELECT * FROM memories WHERE user_id = ? AND id = ?');
  const updateMemory = db.prepare(`
    UPDATE memories
    SET value = ?, kind = ?, status = ?, tags_json = ?, updated_at = ?
    WHERE user_id = ? AND id = ?
  `);
  const forgetKey = db.prepare(`
    UPDATE memories
    SET status = 'forgotten', updated_at = ?
    WHERE user_id = ? AND key = ? AND status != 'forgotten'
  `);
  const forgetId = db.prepare(`
    UPDATE memories
    SET status = 'forgotten', updated_at = ?
    WHERE user_id = ? AND id = ? AND status != 'forgotten'
  `);
  const insertContext = db.prepare(`
    INSERT INTO context_log (
      id, user_id, run_id, step, est_tokens, actual_tokens_in, actual_tokens_out,
      fact_ids_json, sections_json, created_at
    )
    VALUES (
      @id, @user_id, @run_id, @step, @est_tokens, @actual_tokens_in, @actual_tokens_out,
      @fact_ids_json, @sections_json, @created_at
    )
  `);
  const listContextAll = db.prepare(
    'SELECT * FROM context_log WHERE user_id = ? ORDER BY created_at ASC, step ASC, id ASC',
  );
  const listContextRun = db.prepare(
    'SELECT * FROM context_log WHERE user_id = ? AND run_id = ? ORDER BY created_at ASC, step ASC, id ASC',
  );

  function listMemories(userId: string, statuses: FactStatus[], key?: string): StoredMemory[] {
    if (statuses.length === 0) return [];
    const statusSlots = statuses.map(() => '?').join(', ');
    const keyClause = key === undefined ? '' : ' AND key = ?';
    const stmt = db.prepare(
      `SELECT * FROM memories WHERE user_id = ? AND status IN (${statusSlots})${keyClause} ORDER BY updated_at DESC, id DESC`,
    );
    const params: Array<string> = [userId, ...statuses];
    if (key !== undefined) params.push(key);
    const rows = stmt.all(...params) as MemorySqlRow[];
    return rows.map(toMemory);
  }

  return {
    transaction<T>(fn: () => T): T {
      return db.transaction(fn)();
    },

    insert(memory: StoredMemory): void {
      const row = StoredMemorySchema.parse(memory);
      insertMemory.run({
        id: row.id,
        user_id: row.userId,
        key: row.key,
        value: row.value,
        kind: row.kind,
        status: row.status,
        tags_json: JSON.stringify(row.tags),
        created_at: row.createdAt,
        updated_at: row.updatedAt,
      });
    },

    getById(userId: string, id: string): StoredMemory | undefined {
      const row = selectById.get(userId, id) as MemorySqlRow | undefined;
      return row === undefined ? undefined : toMemory(row);
    },

    list(userId: string, statuses: FactStatus[]): StoredMemory[] {
      return listMemories(userId, statuses);
    },

    listByKey(userId: string, key: string, statuses: FactStatus[]): StoredMemory[] {
      return listMemories(userId, statuses, key);
    },

    getMany(userId: string, ids: readonly string[]): StoredMemory[] {
      const unique = [...new Set(ids)];
      if (unique.length === 0) return [];
      const slots = unique.map(() => '?').join(', ');
      const rows = db
        .prepare(`SELECT * FROM memories WHERE user_id = ? AND id IN (${slots})`)
        .all(userId, ...unique) as MemorySqlRow[];
      return rows.map(toMemory);
    },

    update(userId: string, id: string, patch: MemoryPatch): StoredMemory | undefined {
      const tags = z.array(z.string()).parse(patch.tags);
      const result = updateMemory.run(
        patch.value,
        patch.kind,
        patch.status,
        JSON.stringify(tags),
        patch.updatedAt,
        userId,
        id,
      );
      if (result.changes === 0) return undefined;
      const row = selectById.get(userId, id) as MemorySqlRow | undefined;
      return row === undefined ? undefined : toMemory(row);
    },

    forgetByKey(userId: string, key: string, updatedAt: string): number {
      return forgetKey.run(updatedAt, userId, key).changes;
    },

    forgetById(userId: string, id: string, updatedAt: string): boolean {
      return forgetId.run(updatedAt, userId, id).changes > 0;
    },

    insertContext(row: StoredContextLog): void {
      const parsed = StoredContextLogSchema.parse(row);
      insertContext.run({
        id: parsed.id,
        user_id: parsed.userId,
        run_id: parsed.runId,
        step: parsed.step,
        est_tokens: parsed.estTokens,
        actual_tokens_in: parsed.actualTokensIn,
        actual_tokens_out: parsed.actualTokensOut,
        fact_ids_json: JSON.stringify(parsed.factIds),
        sections_json: JSON.stringify(parsed.sections),
        created_at: parsed.createdAt,
      });
    },

    listContext(userId: string, runId?: string): StoredContextLog[] {
      const rows = (
        runId === undefined ? listContextAll.all(userId) : listContextRun.all(userId, runId)
      ) as ContextSqlRow[];
      return rows.map(toContext);
    },
  };
}
