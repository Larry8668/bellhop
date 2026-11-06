import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/engine/errors.js';
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
  const slot = provider.slots[0]!;
  const hold = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot }).hold;
  te.scenarios.push(['BOOK_SUCCESS']);
  const result = engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: `book-${hold.hold_id}` });
  if (result.outcome !== 'booked') throw new Error('expected booked');
  return { booking: result.output.booking, provider, slot };
}

describe('cancel', () => {
  it('default behaviour: first attempt throws transient (503), retry with the same key succeeds', () => {
    const te = createTestEngine();
    const { booking } = bookFirstSlot(te);

    expect(() =>
      te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key' }),
    ).toThrow(ToolError);
    try {
      te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key' });
    } catch (err) {
      expect((err as ToolError).code).toBe('transient');
    }

    const retry = te.engine.cancel(TEST_USER, {
      booking_id: booking.booking_id,
      idempotency_key: 'cancel-key',
    });
    expect(retry.status).toBe('cancelled');
    expect(retry.booking.status).toBe('cancelled');
  });

  it('CANCEL_503_ONCE behaves the same as the default: fail then succeed', () => {
    const te = createTestEngine();
    const { booking } = bookFirstSlot(te);
    te.scenarios.push(['CANCEL_503_ONCE']);

    expect(() =>
      te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key' }),
    ).toThrow(ToolError);

    const retry = te.engine.cancel(TEST_USER, {
      booking_id: booking.booking_id,
      idempotency_key: 'cancel-key',
    });
    expect(retry.status).toBe('cancelled');
  });

  it('CANCEL_OK succeeds on the first attempt', () => {
    const te = createTestEngine();
    const { booking } = bookFirstSlot(te);
    te.scenarios.push(['CANCEL_OK']);

    const out = te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key' });
    expect(out.status).toBe('cancelled');

    const slotRow = te.db
      .prepare('SELECT state FROM slots WHERE provider_id = ? AND start = ?')
      .get(booking.provider_id, booking.slot.start) as { state: string };
    expect(slotRow.state).toBe('open');
  });

  it('already_cancelled: cancelling a booking that is already cancelled', () => {
    const te = createTestEngine();
    const { booking } = bookFirstSlot(te);
    te.scenarios.push(['CANCEL_OK']);
    te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key-1' });

    expect(() =>
      te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key-2' }),
    ).toThrow(ToolError);
    try {
      te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-key-3' });
    } catch (err) {
      expect((err as ToolError).code).toBe('already_cancelled');
    }
  });

  it('booking_not_found for an unknown booking or another user', () => {
    const te = createTestEngine();
    const { booking } = bookFirstSlot(te);

    expect(() =>
      te.engine.cancel('other_user', { booking_id: booking.booking_id, idempotency_key: 'k' }),
    ).toThrow(ToolError);
    expect(() =>
      te.engine.cancel(TEST_USER, { booking_id: 'bk_does_not_exist', idempotency_key: 'k' }),
    ).toThrow(ToolError);
  });

  it('idempotency_mismatch when the same cancel key is reused for a different booking', () => {
    const te = createTestEngine();
    const first = bookFirstSlot(te);
    te.scenarios.push(['CANCEL_OK']);
    te.engine.cancel(TEST_USER, { booking_id: first.booking.booking_id, idempotency_key: 'shared-cancel-key' });

    const from = te.clock.now().toISOString();
    const to = new Date(te.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const search = te.engine.searchProviders(TEST_USER, {
      service: 'electrician',
      area: 'Koramangala',
      date_range: { from, to },
    });
    const provider2 = search.providers[0]!;
    const hold2 = te.engine.holdSlot(TEST_USER, { provider_id: provider2.id, slot: provider2.slots[0]! }).hold;
    te.scenarios.push(['BOOK_SUCCESS']);
    const booked2 = te.engine.book(TEST_USER, { hold_id: hold2.hold_id, idempotency_key: 'book-2' });
    if (booked2.outcome !== 'booked') throw new Error('expected booked');

    expect(() =>
      te.engine.cancel(TEST_USER, {
        booking_id: booked2.output.booking.booking_id,
        idempotency_key: 'shared-cancel-key',
      }),
    ).toThrow(ToolError);
  });
});
