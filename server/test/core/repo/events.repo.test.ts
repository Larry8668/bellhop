import { describe, expect, it } from 'vitest';
import { createEventsRepo } from '../../../src/core/repo/events.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';

describe('eventsRepo', () => {
  it('insert assigns an id and defaults processed to false', () => {
    const repo = createEventsRepo(createTestDb());
    const event = repo.insert({
      user_id: TEST_USER,
      type: 'provider_cancellation',
      booking_id: 'bk_1',
      payload: { reason: 'provider unavailable' },
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(event.id).toBeGreaterThan(0);
    expect(event.processed).toBe(false);
    expect(event.payload).toEqual({ reason: 'provider unavailable' });
  });

  it('listUnprocessed(userId) scopes to that user; listUnprocessed() covers all users', () => {
    const repo = createEventsRepo(createTestDb());
    repo.insert({ user_id: TEST_USER, type: 'x', booking_id: null, payload: {}, created_at: '2026-01-01T00:00:00Z' });
    repo.insert({ user_id: OTHER_USER, type: 'x', booking_id: null, payload: {}, created_at: '2026-01-01T00:00:01Z' });

    expect(repo.listUnprocessed(TEST_USER)).toHaveLength(1);
    expect(repo.listUnprocessed(OTHER_USER)).toHaveLength(1);
    expect(repo.listUnprocessed()).toHaveLength(2);
  });

  it('markProcessed excludes the event from subsequent listUnprocessed calls', () => {
    const repo = createEventsRepo(createTestDb());
    const event = repo.insert({
      user_id: TEST_USER,
      type: 'x',
      booking_id: null,
      payload: {},
      created_at: '2026-01-01T00:00:00Z',
    });

    expect(repo.markProcessed(event.id)).toBe(true);
    expect(repo.markProcessed(event.id)).toBe(false);

    expect(repo.listUnprocessed(TEST_USER)).toEqual([]);
  });

  it('hasForBooking matches type and booking id, including already-processed rows', () => {
    const repo = createEventsRepo(createTestDb());
    const event = repo.insert({
      user_id: TEST_USER,
      type: 'provider_cancelled',
      booking_id: 'bk_1',
      payload: {},
      created_at: '2026-01-01T00:00:00Z',
    });
    repo.markProcessed(event.id);

    expect(repo.hasForBooking('provider_cancelled', 'bk_1')).toBe(true);
    expect(repo.hasForBooking('provider_cancelled', 'bk_2')).toBe(false);
    expect(repo.hasForBooking('other', 'bk_1')).toBe(false);
  });
});
