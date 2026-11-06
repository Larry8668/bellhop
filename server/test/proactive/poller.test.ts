import { describe, expect, it, vi } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import type { ListBookingsOutput } from '@bellhop/shared/contracts';
import type { ProviderClient } from '../../src/provider-client/client.js';
import { createBookingsRepo, createEventsRepo } from '../../src/core/repo/index.js';
import { pollBookings, startPoller } from '../../src/proactive/poller.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../core/helpers.js';
import { makeAppBooking } from '../core/fixtures.js';

const NOW_MS = Date.parse('2026-06-01T00:00:00.000Z');

function futureBooking(userId: string, start: string) {
  return makeAppBooking({
    user_id: userId,
    slot: { start, end: new Date(Date.parse(start) + 60 * 60 * 1000).toISOString() },
  });
}

function listClient(
  answer: (userId: string) => ListBookingsOutput,
): { client: Pick<ProviderClient, 'list_bookings'>; users: string[] } {
  const users: string[] = [];
  return {
    users,
    client: {
      async list_bookings(userId) {
        users.push(userId);
        return answer(userId);
      },
    },
  };
}

function cancelled(bookingId: string): ListBookingsOutput {
  const row = makeAppBooking({ booking_id: bookingId, status: 'cancelled' });
  return {
    bookings: [
      {
        booking_id: row.booking_id,
        user_id: row.user_id,
        provider_id: row.provider_id,
        provider_name: row.provider_name,
        service: row.service,
        slot: row.slot,
        price: row.price,
        currency: row.currency,
        status: 'cancelled',
        created_at: row.synced_at,
        updated_at: row.synced_at,
        when: 'upcoming',
      },
    ],
  };
}

describe('pollBookings', () => {
  it('marks a future booking cancelled and inserts one provider_cancelled event', async () => {
    const db = createTestDb();
    const bookings = createBookingsRepo(db);
    const booking = futureBooking(TEST_USER, '2026-06-02T00:00:00.000Z');
    bookings.upsert(booking);
    const { client, users } = listClient(() => cancelled(booking.booking_id));

    await pollBookings({
      db,
      clock: createFakeClock(NOW_MS),
      providerClient: client,
      logger: createLogger({ name: 'test', level: 'silent' }),
    });

    expect(users).toEqual([TEST_USER]);
    expect(bookings.get(TEST_USER, booking.booking_id)?.status).toBe('cancelled');
    const events = createEventsRepo(db).listUnprocessed(TEST_USER);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'provider_cancelled', booking_id: booking.booking_id, processed: false });
  });

  it('does not insert a second event when the same booking is seen again', async () => {
    const db = createTestDb();
    const bookings = createBookingsRepo(db);
    const booking = futureBooking(TEST_USER, '2026-06-02T00:00:00.000Z');
    bookings.upsert(booking);
    const deps = {
      db,
      clock: createFakeClock(NOW_MS),
      providerClient: listClient(() => cancelled(booking.booking_id)).client,
      logger: createLogger({ name: 'test', level: 'silent' }),
    };

    await pollBookings(deps);
    const synced = bookings.get(TEST_USER, booking.booking_id);
    if (synced === undefined) throw new Error('missing booking');
    bookings.upsert({ ...synced, status: 'confirmed' });
    await pollBookings(deps);

    const rows = db.prepare('SELECT id FROM events').all();
    expect(rows).toHaveLength(1);
    expect(bookings.get(TEST_USER, booking.booking_id)?.status).toBe('cancelled');
  });

  it('skips a past slot without calling the provider', async () => {
    const db = createTestDb();
    const bookings = createBookingsRepo(db);
    const booking = futureBooking(TEST_USER, '2026-05-01T00:00:00.000Z');
    bookings.upsert(booking);
    const { client, users } = listClient(() => cancelled(booking.booking_id));

    await pollBookings({
      db,
      clock: createFakeClock(NOW_MS),
      providerClient: client,
      logger: createLogger({ name: 'test', level: 'silent' }),
    });

    expect(users).toEqual([]);
    expect(bookings.get(TEST_USER, booking.booking_id)?.status).toBe('confirmed');
    expect(createEventsRepo(db).listUnprocessed()).toEqual([]);
  });

  it('leaves the row confirmed when the provider omits the booking', async () => {
    const db = createTestDb();
    const bookings = createBookingsRepo(db);
    const booking = futureBooking(TEST_USER, '2026-06-02T00:00:00.000Z');
    bookings.upsert(booking);
    const { client } = listClient(() => ({ bookings: [] }));

    await pollBookings({
      db,
      clock: createFakeClock(NOW_MS),
      providerClient: client,
      logger: createLogger({ name: 'test', level: 'silent' }),
    });

    expect(bookings.get(TEST_USER, booking.booking_id)?.status).toBe('confirmed');
    expect(createEventsRepo(db).listUnprocessed()).toEqual([]);
  });

  it('stops after maxStatusCalls users, earliest slot first', async () => {
    const db = createTestDb();
    const bookings = createBookingsRepo(db);
    const first = futureBooking(TEST_USER, '2026-06-02T00:00:00.000Z');
    const second = futureBooking(OTHER_USER, '2026-06-03T00:00:00.000Z');
    bookings.upsert(second);
    bookings.upsert(first);
    const { client, users } = listClient((userId) =>
      cancelled(userId === TEST_USER ? first.booking_id : second.booking_id),
    );

    await pollBookings({
      db,
      clock: createFakeClock(NOW_MS),
      providerClient: client,
      logger: createLogger({ name: 'test', level: 'silent' }),
      maxStatusCalls: 1,
    });

    expect(users).toEqual([TEST_USER]);
    expect(bookings.get(TEST_USER, first.booking_id)?.status).toBe('cancelled');
    expect(bookings.get(OTHER_USER, second.booking_id)?.status).toBe('confirmed');
  });
});

describe('startPoller', () => {
  it('does not run after stop, and skips a tick that is still in flight', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const logger = createLogger({ name: 'test', level: 'silent' });
      const stop = startPoller({
        intervalMs: 1_000,
        logger,
        tick: async () => {
          calls += 1;
          await new Promise((resolve) => {
            setTimeout(resolve, 5_000);
          });
        },
      });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toBe(1);

      stop();
      await vi.advanceTimersByTimeAsync(20_000);
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
