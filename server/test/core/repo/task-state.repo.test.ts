import { describe, expect, it } from 'vitest';
import { createTaskStateRepo } from '../../../src/core/repo/task-state.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';

describe('taskStateRepo', () => {
  it('returns undefined for a user with no row', () => {
    const repo = createTaskStateRepo(createTestDb());
    expect(repo.get(TEST_USER)).toBeUndefined();
  });

  it('upsert creates a row with defaults for omitted fields', () => {
    const repo = createTaskStateRepo(createTestDb());
    const state = repo.upsert(TEST_USER, { state: 'GATHERING', updated_at: '2026-01-01T00:00:00Z' });

    expect(state).toMatchObject({
      user_id: TEST_USER,
      state: 'GATHERING',
      service: null,
      area: null,
      budget: null,
      prefs: {},
      run_id: null,
    });
    expect(repo.get(TEST_USER)).toEqual(state);
  });

  it('a partial patch only changes the given fields, keeping the rest', () => {
    const repo = createTaskStateRepo(createTestDb());
    repo.upsert(TEST_USER, {
      state: 'GATHERING',
      service: 'plumber',
      area: 'Indiranagar',
      budget: 1000,
      updated_at: '2026-01-01T00:00:00Z',
    });

    // A correction updates only `area` (plan §6).
    const corrected = repo.upsert(TEST_USER, { area: 'Koramangala', updated_at: '2026-01-01T00:05:00Z' });

    expect(corrected.area).toBe('Koramangala');
    expect(corrected.service).toBe('plumber');
    expect(corrected.budget).toBe(1000);
    expect(corrected.state).toBe('GATHERING');
    expect(corrected.updated_at).toBe('2026-01-01T00:05:00Z');
  });

  it('setState writes state and updated_at without touching other fields', () => {
    const repo = createTaskStateRepo(createTestDb());
    repo.upsert(TEST_USER, { state: 'GATHERING', service: 'electrician', updated_at: '2026-01-01T00:00:00Z' });

    const next = repo.setState(TEST_USER, 'SEARCHING', '2026-01-01T00:01:00Z');

    expect(next.state).toBe('SEARCHING');
    expect(next.service).toBe('electrician');
    expect(next.updated_at).toBe('2026-01-01T00:01:00Z');
  });

  it('a null in the patch explicitly clears a field, distinct from omitting it', () => {
    const repo = createTaskStateRepo(createTestDb());
    repo.upsert(TEST_USER, { budget: 1000, updated_at: '2026-01-01T00:00:00Z' });

    const cleared = repo.upsert(TEST_USER, { budget: null, updated_at: '2026-01-01T00:01:00Z' });
    expect(cleared.budget).toBeNull();
  });

  it('rows are isolated per user (invariant 2: no cross-user access by construction)', () => {
    const repo = createTaskStateRepo(createTestDb());
    repo.upsert(TEST_USER, { state: 'GATHERING', service: 'plumber', updated_at: '2026-01-01T00:00:00Z' });

    expect(repo.get(OTHER_USER)).toBeUndefined();
  });
});
