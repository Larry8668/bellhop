import { describe, expect, it } from 'vitest';
import { AdminStateResponseSchema } from '@bellhop/shared/contracts';
import { createTestEngine, TEST_USER } from './helpers.js';

function bookFirstSlot(te: ReturnType<typeof createTestEngine>) {
  const { engine, clock } = te;
  const from = clock.now().toISOString();
  const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const search = engine.searchProviders(TEST_USER, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = search.providers[0]!;
  const hold = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot: provider.slots[0]! }).hold;
  te.scenarios.push(['BOOK_SUCCESS']);
  const result = engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: `book-${hold.hold_id}` });
  if (result.outcome !== 'booked') throw new Error('expected booked');
  return result.output.booking;
}

describe('admin', () => {
  it('cancelBookingByProvider cancels the booking, reopens the slot, and writes an event', () => {
    const te = createTestEngine();
    const booking = bookFirstSlot(te);

    const cancelled = te.engine.admin.cancelBookingByProvider(booking.booking_id);
    expect(cancelled.status).toBe('cancelled');

    const events = te.db
      .prepare("SELECT type, booking_id, user_id FROM events WHERE type = 'provider_cancelled'")
      .all() as { type: string; booking_id: string; user_id: string }[];
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({
      type: 'provider_cancelled',
      booking_id: booking.booking_id,
      user_id: TEST_USER,
    });

    const slotRow = te.db
      .prepare('SELECT state FROM slots WHERE provider_id = ? AND start = ?')
      .get(booking.provider_id, booking.slot.start) as { state: string };
    expect(slotRow.state).toBe('open');
  });

  it('state() matches AdminStateResponseSchema minus timeout_delay_ms', () => {
    const te = createTestEngine();
    bookFirstSlot(te);
    te.scenarios.push(['CANCEL_503_ONCE']);

    const state = te.engine.admin.state();
    const parsed = AdminStateResponseSchema.omit({ timeout_delay_ms: true }).safeParse(state);
    expect(parsed.success).toBe(true);
  });

  it('reset(seed) wipes holds/bookings/idempotency, reseeds deterministically, and clears scenarios', () => {
    const te = createTestEngine({ seed: 42 });
    bookFirstSlot(te);
    te.scenarios.push(['CANCEL_OK']);

    const providersBefore = te.db.prepare('SELECT id, price FROM providers ORDER BY id').all();

    te.engine.admin.reset(42);

    expect(te.engine.admin.seed()).toBe(42);
    expect(te.engine.admin.state().pending_scenarios).toEqual([]);
    expect(te.engine.admin.state().holds).toEqual([]);
    expect(te.engine.admin.state().bookings).toEqual([]);
    expect(te.engine.admin.state().idempotency).toEqual([]);

    const providersAfter = te.db.prepare('SELECT id, price FROM providers ORDER BY id').all();
    expect(providersAfter).toEqual(providersBefore);
  });

  it('reset() with no seed argument reuses the previous seed', () => {
    const te = createTestEngine({ seed: 7 });
    te.engine.admin.reset();
    expect(te.engine.admin.seed()).toBe(7);
  });
});
