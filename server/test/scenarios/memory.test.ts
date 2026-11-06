import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { MemoryInputError } from '../../src/memory/errors.js';
import { estimateTokens, MEMORY_TOKEN_BUDGET, renderFactLine } from '../../src/memory/select.js';
import { createMemoryService } from '../../src/memory/service.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../core/helpers.js';

function harness() {
  const db = createTestDb();
  const clock = createFakeClock(Date.parse('2026-06-01T00:00:00.000Z'));
  const memory = createMemoryService({ db, clock });
  return { db, clock, memory };
}

function valueFor(key: string, tokens: number): string {
  const valueLen = tokens * 4 - `- ${key}: \n`.length;
  if (valueLen < 1) throw new Error(`key ${key} is too long for ${tokens} tokens`);
  return 'n'.repeat(valueLen);
}

describe('memory scenarios', () => {
  it('S18 correction updates the selected fact value', ({ task }) => {
    task.meta.expected =
      'updating a fact changes the value that selectForContext returns, and the row stays explicit and active';

    const { memory } = harness();
    const fact = memory.remember(TEST_USER, {
      key: 'budget',
      value: '1000',
      kind: 'explicit',
      tags: ['service:plumber', 'area:indiranagar'],
    });
    const before = memory.selectForContext(TEST_USER, { service: 'plumber', area: 'Indiranagar' });
    const updated = memory.update(TEST_USER, fact.id, '1800');
    const after = memory.selectForContext(TEST_USER, { service: 'plumber', area: 'Indiranagar' });

    expect(before.map((item) => item.value)).toEqual(['1000']);
    expect(updated).toMatchObject({ id: fact.id, value: '1800', kind: 'explicit', status: 'active' });
    expect(after.map((item) => item.value)).toEqual(['1800']);

    task.meta.actual = `before=${before[0]?.value} after=${after[0]?.value} kind=${after[0]?.kind} status=${after[0]?.status}`;
  });

  it('S19 forget → never in context', ({ task }) => {
    task.meta.expected =
      'once a fact is forgotten it is never selected again, and context_log refuses to record that id';

    const { memory } = harness();
    const fact = memory.remember(TEST_USER, {
      key: 'budget',
      value: '1000',
      kind: 'explicit',
      tags: ['service:plumber'],
    });
    const before = memory.selectForContext(TEST_USER, { service: 'plumber' });
    memory.logContext({
      userId: TEST_USER,
      runId: 'run_before',
      step: 0,
      estTokens: 8,
      factIds: before.map((item) => item.id),
      sections: { memories: 8 },
    });

    expect(memory.forget(TEST_USER, 'budget')).toBe(true);
    const after = memory.selectForContext(TEST_USER, { service: 'plumber' });
    memory.logContext({
      userId: TEST_USER,
      runId: 'run_after',
      step: 1,
      estTokens: 0,
      factIds: after.map((item) => item.id),
      sections: { memories: 0 },
    });
    expect(() =>
      memory.logContext({
        userId: TEST_USER,
        runId: 'run_rejected',
        step: 2,
        estTokens: 8,
        factIds: [fact.id],
        sections: { memories: 8 },
      }),
    ).toThrow(MemoryInputError);

    const logged = memory.listContextLog(TEST_USER);
    const afterRow = logged.find((row) => row.runId === 'run_after');
    expect(before.map((item) => item.id)).toEqual([fact.id]);
    expect(after).toEqual([]);
    expect(afterRow?.factIds).toEqual([]);
    expect(logged.some((row) => row.runId === 'run_rejected')).toBe(false);
    expect(memory.getProfile(TEST_USER)).toEqual([]);

    task.meta.actual = `selected_before=${before.length} selected_after=${after.length} logged_after=${afterRow?.factIds.length ?? -1} rejected_row=false`;
  });

  it('S20 unconfirmed excluded until confirmed', ({ task }) => {
    task.meta.expected =
      'an inferred fact stays out of selection and context_log until confirm, then it is included as active';

    const { memory } = harness();
    const pending = memory.remember(TEST_USER, {
      key: 'parking',
      value: 'street',
      kind: 'inferred',
      tags: ['general'],
    });
    const before = memory.selectForContext(TEST_USER, { service: 'plumber' });
    expect(() =>
      memory.logContext({
        userId: TEST_USER,
        runId: 'run_early',
        step: 0,
        estTokens: 4,
        factIds: [pending.id],
        sections: { memories: 4 },
      }),
    ).toThrow(MemoryInputError);

    const confirmed = memory.confirm(TEST_USER, pending.id);
    const after = memory.selectForContext(TEST_USER, { service: 'plumber' });
    memory.logContext({
      userId: TEST_USER,
      runId: 'run_after',
      step: 1,
      estTokens: 4,
      factIds: after.map((item) => item.id),
      sections: { memories: 4 },
    });
    const logged = memory.listContextLog(TEST_USER);

    expect(pending.status).toBe('unconfirmed');
    expect(before).toEqual([]);
    expect(confirmed).toMatchObject({ id: pending.id, status: 'active', kind: 'inferred' });
    expect(after.map((item) => item.id)).toEqual([pending.id]);
    expect(logged.map((row) => row.runId)).toEqual(['run_after']);
    expect(logged[0]?.factIds).toEqual([pending.id]);

    task.meta.actual = `selected_before=${before.length} confirmed_status=${confirmed?.status} selected_after=${after.length} logged_runs=${logged.map((row) => row.runId).join(',')}`;
  });

  it('S21 50+ memories under cap, only relevant sent', ({ task }) => {
    task.meta.expected =
      'with 50+ memories, selection stays within 800 tokens and contains only active facts relevant to the service and area';

    const { db, clock, memory } = harness();
    const ctx = { service: 'plumber', area: 'Indiranagar' };
    memory.remember(TEST_USER, { key: 'language', value: 'English', kind: 'explicit', tags: [] });
    clock.advance(1000);

    const relevantIds: string[] = [];
    for (let i = 0; i < 12; i++) {
      const key = `plumber_note_${String(i).padStart(2, '0')}`;
      const fact = memory.remember(TEST_USER, {
        key,
        value: valueFor(key, 100),
        kind: 'explicit',
        tags: ['service:plumber', 'area:indiranagar'],
      });
      const cost = estimateTokens(renderFactLine(fact));
      expect(cost).toBe(100);
      relevantIds.push(fact.id);
      clock.advance(1000);
    }

    for (let i = 0; i < 30; i++) {
      memory.remember(TEST_USER, {
        key: `favorite_cuisine_${i}`,
        value: `dish ${i}`,
        kind: 'explicit',
        tags: ['topic:food'],
      });
      clock.advance(1000);
    }
    const forgottenIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const fact = memory.remember(TEST_USER, {
        key: `old_plumber_${i}`,
        value: `retired ${i}`,
        kind: 'explicit',
        tags: ['service:plumber', 'area:indiranagar'],
      });
      forgottenIds.push(fact.id);
      clock.advance(1000);
    }
    for (const id of forgottenIds) memory.forgetById(TEST_USER, id);
    clock.advance(1000);
    const unconfirmedIds: string[] = [];
    for (let i = 0; i < 10; i++) {
      const fact = memory.remember(TEST_USER, {
        key: `guess_${i}`,
        value: `maybe ${i}`,
        kind: 'inferred',
        tags: ['service:plumber', 'general'],
      });
      unconfirmedIds.push(fact.id);
      clock.advance(1000);
    }
    const electrician = memory.remember(TEST_USER, {
      key: 'electrician_only',
      value: 'Metro Electricals',
      kind: 'explicit',
      tags: ['service:electrician'],
    });
    clock.advance(1000);
    const wrongArea = memory.remember(TEST_USER, {
      key: 'wrong_area',
      value: 'Koramangala plumber',
      kind: 'explicit',
      tags: ['service:plumber', 'area:koramangala'],
    });
    clock.advance(1000);
    const other = memory.remember(OTHER_USER, {
      key: 'plumber_note_secret',
      value: 'not yours',
      kind: 'explicit',
      tags: ['service:plumber', 'area:indiranagar', 'general'],
    });

    const stored = (
      db.prepare('SELECT COUNT(*) AS n FROM memories WHERE user_id = ?').get(TEST_USER) as { n: number }
    ).n;
    const selected = memory.selectForContext(TEST_USER, ctx);
    const tokens = selected.reduce((sum, item) => sum + estimateTokens(renderFactLine(item)), 0);
    const expectedIds = relevantIds.slice(4).reverse();

    expect(stored).toBeGreaterThanOrEqual(50);
    expect(selected.map((item) => item.id)).toEqual(expectedIds);
    expect(tokens).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
    expect(tokens).toBe(800);
    expect(selected.every((item) => item.status === 'active')).toBe(true);
    const selectedIds = new Set(selected.map((item) => item.id));
    expect(forgottenIds.some((id) => selectedIds.has(id))).toBe(false);
    expect(unconfirmedIds.some((id) => selectedIds.has(id))).toBe(false);
    expect(selectedIds.has(electrician.id)).toBe(false);
    expect(selectedIds.has(wrongArea.id)).toBe(false);
    expect(selectedIds.has(other.id)).toBe(false);
    expect(selected.some((item) => item.key.startsWith('favorite_cuisine'))).toBe(false);

    memory.logContext({
      userId: TEST_USER,
      runId: 'run_21',
      step: 0,
      estTokens: tokens,
      factIds: selected.map((item) => item.id),
      sections: { system: 100, memories: tokens, task: 40, history: 200, tools: 80 },
    });
    const logged = memory.listContextLog(TEST_USER, 'run_21');
    expect(logged[0]?.factIds).toEqual(expectedIds);

    task.meta.actual = `stored=${stored} selected=${selected.length} tokens=${tokens} forgotten_selected=0 unconfirmed_selected=0`;
  });

  it('lint flags two active facts that share a key and disagree', () => {
    const { clock, memory } = harness();
    const street = memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'inferred' });
    clock.advance(1000);
    const basement = memory.remember(TEST_USER, { key: 'parking', value: 'basement', kind: 'inferred' });
    memory.confirm(TEST_USER, street.id);
    clock.advance(1000);
    memory.confirm(TEST_USER, basement.id);
    memory.remember(TEST_USER, { key: 'parking', value: 'street', kind: 'explicit' });

    expect(memory.lint(TEST_USER)).toEqual([]);
    clock.advance(1000);
    const again = memory.remember(TEST_USER, { key: 'parking', value: 'driveway', kind: 'inferred' });
    clock.advance(1000);
    memory.confirm(TEST_USER, again.id);
    expect(memory.lint(TEST_USER)).toEqual([{ key: 'parking', values: ['driveway', 'street'] }]);
    expect(memory.renderProfileMd(TEST_USER)).toContain('which should I keep?');
  });
});
