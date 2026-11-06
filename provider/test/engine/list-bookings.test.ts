import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/engine/errors.js';
import { createTestEngine, TEST_USER } from './helpers.js';

function bookSlot(
  te: ReturnType<typeof createTestEngine>,
  service: 'plumber' | 'electrician',
  area: string,
  slotIndex: number,
) {
  const { engine, clock } = te;
  const from = clock.now().toISOString();
  const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const search = engine.searchProviders(TEST_USER, { service, area, date_range: { from, to } });
  const provider = search.providers[0]!;
  const slot = provider.slots[slotIndex] ?? provider.slots[0]!;
  const hold = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot }).hold;
  te.scenarios.push(['BOOK_SUCCESS']);
  const result = engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: `book-${hold.hold_id}` });
  if (result.outcome !== 'booked') throw new Error('expected booked');
  return result.output.booking;
}

describe('listBookings', () => {
  it('splits bookings into past and upcoming by slot start, ordered by slot_start', () => {
    const te = createTestEngine();
    const earlierBooking = bookSlot(te, 'plumber', 'Indiranagar', 0);

    // Move the clock forward past the booked slot so it becomes 'past'.
    const slotEndMs = Date.parse(earlierBooking.slot.end);
    te.clock.set(slotEndMs + 60_000);

    const laterBooking = bookSlot(te, 'electrician', 'Koramangala', 0);

    const out = te.engine.listBookings(TEST_USER, { user_id: TEST_USER });
    const earlierEntry = out.bookings.find((b) => b.booking_id === earlierBooking.booking_id)!;
    const laterEntry = out.bookings.find((b) => b.booking_id === laterBooking.booking_id)!;

    expect(earlierEntry.when).toBe('past');
    expect(laterEntry.when).toBe('upcoming');

    const starts = out.bookings.map((b) => Date.parse(b.slot.start));
    const sorted = [...starts].sort((a, b) => a - b);
    expect(starts).toEqual(sorted);
  });

  it('rejects when input.user_id does not match the authenticated userId', () => {
    const te = createTestEngine();
    bookSlot(te, 'plumber', 'Indiranagar', 0);

    expect(() => te.engine.listBookings(TEST_USER, { user_id: 'someone_else' })).toThrow(ToolError);
  });
});
