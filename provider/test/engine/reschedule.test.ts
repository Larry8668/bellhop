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
  const hold = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot: provider.slots[0]! }).hold;
  te.scenarios.push(['BOOK_SUCCESS']);
  const result = engine.book(TEST_USER, { hold_id: hold.hold_id, idempotency_key: `book-${hold.hold_id}` });
  if (result.outcome !== 'booked') throw new Error('expected booked');
  return { booking: result.output.booking, provider };
}

describe('reschedule', () => {
  it('RESCHEDULE_CONFLICT: throws slot_conflict with up to 3 alternatives', () => {
    const te = createTestEngine();
    const { booking, provider } = bookFirstSlot(te);
    const anotherOpenSlot = provider.slots.find((s) => s.start !== booking.slot.start)!;
    te.scenarios.push(['RESCHEDULE_CONFLICT']);

    try {
      te.engine.reschedule(TEST_USER, {
        booking_id: booking.booking_id,
        slot: anotherOpenSlot,
        idempotency_key: 'resched-1',
      });
      throw new Error('expected slot_conflict');
    } catch (err) {
      expect(err).toBeInstanceOf(ToolError);
      const toolErr = err as ToolError;
      expect(toolErr.code).toBe('slot_conflict');
      const details = toolErr.details as { alternatives: { start: string; end: string }[] };
      expect(details.alternatives.length).toBeGreaterThan(0);
      expect(details.alternatives.length).toBeLessThanOrEqual(3);
    }
  });

  it('conflict because the target slot is not actually open, then succeeds against a real open slot', () => {
    const te = createTestEngine();
    const { booking, provider } = bookFirstSlot(te);

    // The provider's held/booked slot (its own original slot) is not 'open' anymore.
    expect(() =>
      te.engine.reschedule(TEST_USER, {
        booking_id: booking.booking_id,
        slot: booking.slot,
        idempotency_key: 'resched-self',
      }),
    ).toThrow(ToolError);

    const anotherOpenSlot = provider.slots.find((s) => s.start !== booking.slot.start)!;
    const out = te.engine.reschedule(TEST_USER, {
      booking_id: booking.booking_id,
      slot: anotherOpenSlot,
      idempotency_key: 'resched-real',
    });

    expect(out.status).toBe('rescheduled');
    expect(out.previous_slot).toEqual(booking.slot);
    expect(out.booking.slot).toEqual(anotherOpenSlot);
    expect(out.booking.status).toBe('rescheduled');
  });

  it('booking_not_found / booking_cancelled', () => {
    const te = createTestEngine();
    const { booking, provider } = bookFirstSlot(te);
    const anotherOpenSlot = provider.slots.find((s) => s.start !== booking.slot.start)!;

    expect(() =>
      te.engine.reschedule('other_user', {
        booking_id: booking.booking_id,
        slot: anotherOpenSlot,
        idempotency_key: 'k',
      }),
    ).toThrow(ToolError);

    te.scenarios.push(['CANCEL_OK']);
    te.engine.cancel(TEST_USER, { booking_id: booking.booking_id, idempotency_key: 'cancel-it' });

    try {
      te.engine.reschedule(TEST_USER, {
        booking_id: booking.booking_id,
        slot: anotherOpenSlot,
        idempotency_key: 'k2',
      });
      throw new Error('expected booking_cancelled');
    } catch (err) {
      expect((err as ToolError).code).toBe('booking_cancelled');
    }
  });

  it('idempotency replay returns the same result without a second write', () => {
    const te = createTestEngine();
    const { booking, provider } = bookFirstSlot(te);
    const anotherOpenSlot = provider.slots.find((s) => s.start !== booking.slot.start)!;

    const first = te.engine.reschedule(TEST_USER, {
      booking_id: booking.booking_id,
      slot: anotherOpenSlot,
      idempotency_key: 'resched-key',
    });
    const second = te.engine.reschedule(TEST_USER, {
      booking_id: booking.booking_id,
      slot: anotherOpenSlot,
      idempotency_key: 'resched-key',
    });
    expect(second).toEqual(first);
  });
});
