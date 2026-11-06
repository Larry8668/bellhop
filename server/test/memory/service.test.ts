import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { MemoryInputError } from '../../src/memory/errors.js';
import { createMemoryRepo } from '../../src/memory/repo.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../core/helpers.js';

function harness() {
  const db = createTestDb();
  const clock = createFakeClock(Date.parse('2026-06-01T00:00:00.000Z'));
  const memory = createMemoryService({ db, clock });
  return { db, clock, memory };
}

describe('memoryService', () => {
  it('stores explicit facts as active and inferred facts as unconfirmed', () => {
    const { memory } = harness();
    const explicit = memory.remember(TEST_USER, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });
    const inferred = memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'inferred' });
    expect(explicit).toMatchObject({ status: 'active', kind: 'explicit', tags: ['general'] });
    expect(inferred).toMatchObject({ status: 'unconfirmed', kind: 'inferred', tags: [] });
    expect(memory.selectForContext(TEST_USER, { service: 'plumber' }).map((fact) => fact.id)).toEqual([explicit.id]);
    expect(memory.getProfile(TEST_USER).map((fact) => fact.id).sort()).toEqual([explicit.id, inferred.id].sort());
  });

  it('overwrites the active value for an explicit key and keeps tags when the new call omits them', () => {
    const { clock, memory } = harness();
    const first = memory.remember(TEST_USER, {
      key: 'budget',
      value: '1000',
      kind: 'explicit',
      tags: ['general'],
    });
    clock.advance(1000);
    const second = memory.remember(TEST_USER, { key: 'budget', value: '1500', kind: 'explicit' });
    expect(second.id).toBe(first.id);
    expect(second.value).toBe('1500');
    expect(second.tags).toEqual(['general']);
    clock.advance(1000);
    const third = memory.remember(TEST_USER, {
      key: 'budget',
      value: '1800',
      kind: 'explicit',
      tags: ['service:plumber'],
    });
    expect(third.tags).toEqual(['service:plumber']);
    expect(memory.getProfile(TEST_USER).filter((fact) => fact.key === 'budget')).toHaveLength(1);
  });

  it('does not let an explicit remember touch another user or an unconfirmed row', () => {
    const { memory } = harness();
    const other = memory.remember(OTHER_USER, { key: 'budget', value: '1', kind: 'explicit' });
    const pending = memory.remember(TEST_USER, { key: 'budget', value: 'guess', kind: 'inferred' });
    const explicit = memory.remember(TEST_USER, { key: 'budget', value: '1000', kind: 'explicit' });
    expect(explicit.id).not.toBe(other.id);
    expect(memory.getProfile(OTHER_USER)).toEqual([expect.objectContaining({ id: other.id, value: '1' })]);
    expect(memory.getProfile(TEST_USER).map((fact) => fact.id).sort()).toEqual([explicit.id, pending.id].sort());
  });

  it('forgets every status of that key for this user only', () => {
    const { memory } = harness();
    memory.remember(TEST_USER, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });
    memory.remember(TEST_USER, { key: 'budget', value: 'guess', kind: 'inferred' });
    memory.remember(OTHER_USER, { key: 'budget', value: '9', kind: 'explicit', tags: ['general'] });
    expect(memory.forget(TEST_USER, 'budget')).toBe(true);
    expect(memory.forget(TEST_USER, 'budget')).toBe(false);
    expect(memory.getProfile(TEST_USER)).toEqual([]);
    expect(memory.selectForContext(TEST_USER, {})).toEqual([]);
    expect(memory.getProfile(OTHER_USER)).toHaveLength(1);
  });

  it('confirm moves unconfirmed to active and leaves kind inferred; update makes a fact explicit', () => {
    const { memory } = harness();
    const pending = memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'inferred', tags: ['general'] });
    expect(memory.confirm(OTHER_USER, pending.id)).toBeNull();
    const confirmed = memory.confirm(TEST_USER, pending.id);
    expect(confirmed).toMatchObject({ id: pending.id, status: 'active', kind: 'inferred', value: 'street' });
    expect(memory.confirm(TEST_USER, pending.id)?.status).toBe('active');

    const edited = memory.update(TEST_USER, pending.id, 'basement');
    expect(edited).toMatchObject({ value: 'basement', kind: 'explicit', status: 'active' });
    expect(memory.update(OTHER_USER, pending.id, 'stolen')).toBeNull();
    expect(memory.update(TEST_USER, 'missing', 'x')).toBeNull();
    expect(() => memory.update(TEST_USER, pending.id, '   ')).toThrow(MemoryInputError);
  });

  it('forgetById is scoped, and a forgotten fact cannot be confirmed', () => {
    const { memory } = harness();
    const fact = memory.remember(TEST_USER, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });
    expect(memory.forgetById(OTHER_USER, fact.id)).toBe(false);
    expect(memory.forgetById(TEST_USER, fact.id)).toBe(true);
    expect(memory.forgetById(TEST_USER, fact.id)).toBe(false);
    expect(memory.confirm(TEST_USER, fact.id)).toBeNull();
    expect(memory.selectForContext(TEST_USER, {})).toEqual([]);
    const restored = memory.update(TEST_USER, fact.id, '1200');
    expect(restored).toMatchObject({ status: 'active', kind: 'explicit', value: '1200' });
    expect(memory.selectForContext(TEST_USER, {}).map((item) => item.value)).toEqual(['1200']);
  });

  it('lint lists only active facts that share a key and disagree, and profile.md asks which to keep', () => {
    const { clock, memory, db } = harness();
    const repo = createMemoryRepo(db);
    const first = memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'inferred' });
    clock.advance(1000);
    const second = memory.remember(TEST_USER, { key: 'parking', value: 'basement', kind: 'inferred' });
    memory.confirm(TEST_USER, first.id);
    clock.advance(1000);
    memory.confirm(TEST_USER, second.id);
    memory.remember(TEST_USER, { key: 'parking', value: 'maybe roof', kind: 'inferred' });
    repo.insert({
      id: 'mem_same',
      userId: TEST_USER,
      key: 'color',
      value: 'blue',
      kind: 'explicit',
      status: 'active',
      tags: [],
      createdAt: '2026-06-01T00:00:00.000Z',
      updatedAt: '2026-06-01T00:00:00.000Z',
    });
    repo.insert({
      id: 'mem_same_2',
      userId: TEST_USER,
      key: 'color',
      value: 'blue',
      kind: 'explicit',
      status: 'active',
      tags: [],
      createdAt: '2026-06-01T00:00:01.000Z',
      updatedAt: '2026-06-01T00:00:01.000Z',
    });

    expect(memory.lint(TEST_USER)).toEqual([{ key: 'parking', values: ['basement', 'street'] }]);
    expect(memory.renderProfileMd(TEST_USER)).toContain('**parking**: "basement" vs "street" — which should I keep?');
    expect(memory.lint(OTHER_USER)).toEqual([]);
  });

  it('an explicit remember collapses older active duplicates so the contradiction goes away', () => {
    const { db, clock, memory } = harness();
    const repo = createMemoryRepo(db);
    repo.insert({
      id: 'mem_a',
      userId: TEST_USER,
      key: 'budget',
      value: '1000',
      kind: 'explicit',
      status: 'active',
      tags: ['general'],
      createdAt: '2026-05-01T00:00:00.000Z',
      updatedAt: '2026-05-01T00:00:00.000Z',
    });
    repo.insert({
      id: 'mem_b',
      userId: TEST_USER,
      key: 'budget',
      value: '2000',
      kind: 'explicit',
      status: 'active',
      tags: ['general'],
      createdAt: '2026-05-02T00:00:00.000Z',
      updatedAt: '2026-05-02T00:00:00.000Z',
    });
    expect(memory.lint(TEST_USER)).toEqual([{ key: 'budget', values: ['2000', '1000'] }]);
    clock.advance(1000);
    const kept = memory.remember(TEST_USER, { key: 'budget', value: '1500', kind: 'explicit' });
    expect(kept.id).toBe('mem_b');
    expect(memory.lint(TEST_USER)).toEqual([]);
    expect(memory.getProfile(TEST_USER).filter((fact) => fact.key === 'budget')).toEqual([
      expect.objectContaining({ id: 'mem_b', value: '1500', status: 'active' }),
    ]);
  });

  it('refuses to log a forgotten, unconfirmed, or other user fact id', () => {
    const { memory } = harness();
    const active = memory.remember(TEST_USER, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });
    const pending = memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'inferred' });
    const other = memory.remember(OTHER_USER, { key: 'budget', value: '9', kind: 'explicit', tags: ['general'] });
    const entry = {
      userId: TEST_USER,
      runId: 'run_1',
      step: 0,
      estTokens: 10,
      sections: { memories: 10 },
    };
    expect(() => memory.logContext({ ...entry, factIds: [pending.id] })).toThrow(MemoryInputError);
    expect(() => memory.logContext({ ...entry, factIds: [other.id] })).toThrow(MemoryInputError);
    memory.forgetById(TEST_USER, active.id);
    expect(() => memory.logContext({ ...entry, factIds: [active.id] })).toThrow(MemoryInputError);
    expect(memory.listContextLog(TEST_USER)).toEqual([]);

    const restored = memory.update(TEST_USER, active.id, '1000');
    expect(restored).not.toBeNull();
    memory.logContext({ ...entry, factIds: [active.id] });
    const logged = memory.listContextLog(TEST_USER, 'run_1');
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatchObject({
      factIds: [active.id],
      actualTokensIn: null,
      actualTokensOut: null,
      sections: { memories: 10 },
    });
    expect(memory.listContextLog(OTHER_USER, 'run_1')).toEqual([]);
  });

  it('rejects a blank remember and an empty user id', () => {
    const { memory } = harness();
    expect(() => memory.remember(TEST_USER, { key: '  ', value: 'x', kind: 'explicit' })).toThrow(MemoryInputError);
    expect(() => memory.remember('', { key: 'budget', value: '1', kind: 'explicit' })).toThrow(MemoryInputError);
  });

  it('uses the injected clock for timestamps', () => {
    const db = createTestDb();
    const clock = createFakeClock(Date.parse('2026-03-01T00:00:00.000Z'));
    const memory = createMemoryService({ db, clock });
    const fact = memory.remember(TEST_USER, { key: 'budget', value: '1', kind: 'explicit' });
    const row = db.prepare('SELECT created_at FROM memories WHERE id = ?').get(fact.id) as { created_at: string };
    expect(row.created_at).toBe('2026-03-01T00:00:00.000Z');
  });
});
