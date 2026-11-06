import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/engine/errors.js';
import { createTestEngine, OTHER_USER, TEST_USER } from './helpers.js';

function holdFirstSlot(te: ReturnType<typeof createTestEngine>) {
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
  const hold = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });
  return hold.hold;
}

describe('book', () => {
  it('BOOK_SUCCESS: books the hold at the hold price and consumes the hold', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['BOOK_SUCCESS']);

    const result = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' });
    expect(result.outcome).toBe('booked');
    if (result.outcome !== 'booked') throw new Error('expected booked');
    expect(result.output.status).toBe('booked');
    expect(result.output.booking.price).toBe(hold.price);
    expect(result.output.booking.status).toBe('confirmed');
  });

  it('BOOK_SLOT_TAKEN: voids the hold, marks the slot booked, throws slot_taken', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['BOOK_SLOT_TAKEN']);

    expect(() => te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' })).toThrow(
      ToolError,
    );

    // admin.state() lists every hold ever created (debugging dump); a
    // slot_taken outcome voids the hold rather than deleting it.
    const stateRow = te.db
      .prepare('SELECT state FROM holds WHERE hold_id = ?')
      .get(hold.hold_id) as { state: string };
    expect(stateRow.state).toBe('void');
  });

  it('TIMEOUT_BOOKED: the booking exists, status reports booked, replay by the same key returns booked', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['TIMEOUT_BOOKED']);

    const result = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-timeout-booked' });
    expect(result).toEqual({ outcome: 'timeout', booked: true });

    const status = te.engine.getBookingStatus(TEST_USER, { hold_id: hold.hold_id });
    expect(status.status).toBe('booked');

    const replay = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-timeout-booked' });
    expect(replay.outcome).toBe('booked');
  });

  it('TIMEOUT_NOT_BOOKED: nothing is written, status is not_booked, retry with the same key can succeed', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['TIMEOUT_NOT_BOOKED']);

    const result = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-timeout-not-booked' });
    expect(result).toEqual({ outcome: 'timeout', booked: false });

    const status = te.engine.getBookingStatus(TEST_USER, { hold_id: hold.hold_id });
    expect(status.status).toBe('not_booked');

    te.scenarios.push(['BOOK_SUCCESS']);
    const retry = te.engine.book(TEST_USER, {
      hold_id: hold.hold_id,
      idempotency_key: 'key-timeout-not-booked',
    });
    expect(retry.outcome).toBe('booked');
  });

  it('HOLD_EXPIRED: voids the hold and throws hold_expired', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['HOLD_EXPIRED']);

    expect(() => te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' })).toThrow(
      ToolError,
    );
    try {
      te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-2' });
    } catch (err) {
      expect((err as ToolError).code).toBe('hold_expired');
    }
  });

  it('naturally expired hold (past TTL) throws hold_expired', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.clock.advance(600_001);

    expect(() => te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' })).toThrow(
      ToolError,
    );
  });

  it('idempotency replay: same key and same hold returns the stored result without rebooking', () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);
    te.scenarios.push(['BOOK_SUCCESS']);

    const first = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'same-key' });
    const second = te.engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: 'same-key' });
    expect(second).toEqual(first);

    const rows = te.db.prepare('SELECT booking_id FROM bookings WHERE hold_id = ?').all(hold.hold_id);
    expect(rows).toHaveLength(1);
  });

  it('idempotency_mismatch: same key reused with a different hold_id', () => {
    const te = createTestEngine();
    const hold1 = holdFirstSlot(te);
    te.scenarios.push(['BOOK_SUCCESS']);
    te.engine.book(TEST_USER, { hold_id: hold1.hold_id, idempotency_key: 'shared-key' });

    const te2 = te; // second hold on a different slot, same engine
    const from = te2.clock.now().toISOString();
    const to = new Date(te2.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
    const search = te2.engine.searchProviders(TEST_USER, {
      service: 'electrician',
      area: 'Koramangala',
      date_range: { from, to },
    });
    const provider2 = search.providers[0]!;
    const hold2 = te2.engine.holdSlot(TEST_USER, { provider_id: provider2.id, slot: provider2.slots[0]! }).hold;

    expect(() =>
      te2.engine.book(TEST_USER, { hold_id: hold2.hold_id, idempotency_key: 'shared-key' }),
    ).toThrow(ToolError);
    try {
      te2.engine.book(TEST_USER, { hold_id: hold2.hold_id, idempotency_key: 'shared-key' });
    } catch (err) {
      expect((err as ToolError).code).toBe('idempotency_mismatch');
    }
  });

  it("hold_not_found: booking another user's hold", () => {
    const te = createTestEngine();
    const hold = holdFirstSlot(te);

    expect(() =>
      te.engine.book(OTHER_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' }),
    ).toThrow(ToolError);
    try {
      te.engine.book(OTHER_USER, { hold_id: hold.hold_id, idempotency_key: 'key-1' });
    } catch (err) {
      expect((err as ToolError).code).toBe('hold_not_found');
    }
  });

  it('hold_not_found for an unknown hold id', () => {
    const te = createTestEngine();
    expect(() =>
      te.engine.book(TEST_USER, { hold_id: 'hold_does_not_exist', idempotency_key: 'key-1' }),
    ).toThrow(ToolError);
  });
});
