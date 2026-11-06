import { describe, expect, it } from 'vitest';
import { createBookingsRepo } from '../../../src/core/repo/bookings.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';
import { makeAppBooking } from '../fixtures.js';

describe('bookingsRepo', () => {
  it('round-trips upsert -> get', () => {
    const repo = createBookingsRepo(createTestDb());
    const booking = makeAppBooking();

    repo.upsert(booking);
    expect(repo.get(TEST_USER, booking.booking_id)).toEqual(booking);
  });

  it('upsert on the same booking_id overwrites the row (re-sync from the provider)', () => {
    const repo = createBookingsRepo(createTestDb());
    const booking = makeAppBooking({ status: 'confirmed' });
    repo.upsert(booking);

    const cancelled = { ...booking, status: 'cancelled' as const, synced_at: '2026-01-02T00:00:00Z' };
    repo.upsert(cancelled);

    expect(repo.get(TEST_USER, booking.booking_id)).toEqual(cancelled);
  });

  it('cross-user get/list return undefined/empty', () => {
    const repo = createBookingsRepo(createTestDb());
    const booking = makeAppBooking();
    repo.upsert(booking);

    expect(repo.get(OTHER_USER, booking.booking_id)).toBeUndefined();
    expect(repo.list(OTHER_USER)).toEqual([]);
  });

  it('list returns every booking for the user, ordered by slot start', () => {
    const repo = createBookingsRepo(createTestDb());
    const later = makeAppBooking({ slot: { start: '2026-02-01T00:00:00Z', end: '2026-02-01T01:00:00Z' } });
    const earlier = makeAppBooking({ slot: { start: '2026-01-01T00:00:00Z', end: '2026-01-01T01:00:00Z' } });

    repo.upsert(later);
    repo.upsert(earlier);

    expect(repo.list(TEST_USER).map((b) => b.booking_id)).toEqual([earlier.booking_id, later.booking_id]);
  });
});
