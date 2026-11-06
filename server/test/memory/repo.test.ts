import { describe, expect, it } from 'vitest';
import { createMemoryRepo, type StoredMemory } from '../../src/memory/repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../core/helpers.js';

const AT = '2026-06-01T00:00:00.000Z';

function row(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: overrides.id ?? 'mem_1',
    userId: overrides.userId ?? TEST_USER,
    key: overrides.key ?? 'budget',
    value: overrides.value ?? '1000',
    kind: overrides.kind ?? 'explicit',
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? ['general'],
    createdAt: overrides.createdAt ?? AT,
    updatedAt: overrides.updatedAt ?? AT,
  };
}

describe('memoryRepo', () => {
  it('creates memories and context_log with the phase 4 columns and indexes', () => {
    const db = createTestDb();
    const columns = (table: string): string[] => {
      const info = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return info.map((column) => column.name);
    };
    expect(columns('memories')).toEqual([
      'id',
      'user_id',
      'key',
      'value',
      'kind',
      'status',
      'tags_json',
      'created_at',
      'updated_at',
    ]);
    expect(columns('context_log')).toEqual([
      'id',
      'user_id',
      'run_id',
      'step',
      'est_tokens',
      'actual_tokens_in',
      'actual_tokens_out',
      'fact_ids_json',
      'sections_json',
      'created_at',
    ]);
    const indexes = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_%'")
      .all() as Array<{ name: string }>;
    const names = indexes.map((index) => index.name);
    expect(names).toEqual(
      expect.arrayContaining(['idx_memories_user_id', 'idx_memories_user_status', 'idx_context_log_user_run']),
    );

    expect(() => {
      db.prepare(
        `INSERT INTO memories (id, user_id, key, value, kind, status, tags_json, created_at, updated_at)
         VALUES ('bad', 'u', 'k', 'v', 'guess', 'active', '[]', ?, ?)`,
      ).run(AT, AT);
    }).toThrow();
  });

  it('reads and updates only the owning user, newest first', () => {
    const db = createTestDb();
    const repo = createMemoryRepo(db);
    repo.insert(row({ id: 'mem_old', updatedAt: '2026-06-01T00:00:00.000Z', value: 'old' }));
    repo.insert(row({ id: 'mem_new', updatedAt: '2026-06-02T00:00:00.000Z', value: 'new' }));
    repo.insert(row({ id: 'mem_other', userId: OTHER_USER, value: 'secret' }));

    expect(repo.getById(OTHER_USER, 'mem_old')).toBeUndefined();
    expect(repo.list(TEST_USER, ['active']).map((fact) => fact.id)).toEqual(['mem_new', 'mem_old']);
    expect(repo.list(OTHER_USER, ['active']).map((fact) => fact.value)).toEqual(['secret']);

    const updated = repo.update(TEST_USER, 'mem_old', {
      value: 'changed',
      kind: 'explicit',
      status: 'active',
      tags: ['service:plumber'],
      updatedAt: '2026-06-03T00:00:00.000Z',
    });
    expect(updated?.value).toBe('changed');
    expect(updated?.tags).toEqual(['service:plumber']);
    expect(repo.update(OTHER_USER, 'mem_old', {
      value: 'stolen',
      kind: 'explicit',
      status: 'active',
      tags: [],
      updatedAt: '2026-06-04T00:00:00.000Z',
    })).toBeUndefined();
    expect(repo.getById(TEST_USER, 'mem_old')?.value).toBe('changed');
  });

  it('forgets by key or id without touching another user or an already forgotten row', () => {
    const db = createTestDb();
    const repo = createMemoryRepo(db);
    repo.insert(row({ id: 'mem_a', key: 'budget' }));
    repo.insert(row({ id: 'mem_b', key: 'budget', status: 'unconfirmed', kind: 'inferred' }));
    repo.insert(row({ id: 'mem_other', userId: OTHER_USER, key: 'budget' }));

    expect(repo.forgetByKey(TEST_USER, 'budget', '2026-06-02T00:00:00.000Z')).toBe(2);
    expect(repo.forgetByKey(TEST_USER, 'budget', '2026-06-03T00:00:00.000Z')).toBe(0);
    expect(repo.getById(OTHER_USER, 'mem_other')?.status).toBe('active');
    expect(repo.list(TEST_USER, ['forgotten']).map((fact) => fact.id).sort()).toEqual(['mem_a', 'mem_b']);

    repo.insert(row({ id: 'mem_c', key: 'hours' }));
    expect(repo.forgetById(OTHER_USER, 'mem_c', '2026-06-04T00:00:00.000Z')).toBe(false);
    expect(repo.forgetById(TEST_USER, 'mem_c', '2026-06-04T00:00:00.000Z')).toBe(true);
    expect(repo.forgetById(TEST_USER, 'mem_c', '2026-06-05T00:00:00.000Z')).toBe(false);
    expect(repo.getById(TEST_USER, 'mem_c')?.status).toBe('forgotten');
  });

  it('stores a context_log row and lists it only for that user and run', () => {
    const db = createTestDb();
    const repo = createMemoryRepo(db);
    repo.insertContext({
      id: 'ctx_1',
      userId: TEST_USER,
      runId: 'run_a',
      step: 1,
      estTokens: 120,
      actualTokensIn: null,
      actualTokensOut: null,
      factIds: ['mem_1'],
      sections: { system: 10, memories: 20, task: 5, history: 30, tools: 15 },
      createdAt: AT,
    });
    repo.insertContext({
      id: 'ctx_2',
      userId: TEST_USER,
      runId: 'run_b',
      step: 0,
      estTokens: 10,
      actualTokensIn: null,
      actualTokensOut: null,
      factIds: [],
      sections: { memories: 0 },
      createdAt: '2026-06-01T00:01:00.000Z',
    });
    repo.insertContext({
      id: 'ctx_other',
      userId: OTHER_USER,
      runId: 'run_a',
      step: 0,
      estTokens: 1,
      actualTokensIn: null,
      actualTokensOut: null,
      factIds: ['mem_x'],
      sections: { memories: 1 },
      createdAt: AT,
    });

    const run = repo.listContext(TEST_USER, 'run_a');
    expect(run).toHaveLength(1);
    expect(run[0]).toMatchObject({
      id: 'ctx_1',
      factIds: ['mem_1'],
      actualTokensIn: null,
      actualTokensOut: null,
      sections: { system: 10, memories: 20, task: 5, history: 30, tools: 15 },
    });
    expect(repo.listContext(TEST_USER).map((entry) => entry.id)).toEqual(['ctx_1', 'ctx_2']);
    expect(repo.listContext(OTHER_USER, 'run_a').map((entry) => entry.id)).toEqual(['ctx_other']);
  });
});
