import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BookOutput, GetBookingStatusOutput, ToolError } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '../../src/testing.js';
import { bookFirstSlot, getAdminState, holdFirstSlot, postTool, pushScenario } from './helpers.js';

describe('forced scenarios over HTTP (POST /__admin/scenario)', () => {
  let tp: TestProvider;

  beforeEach(async () => {
    tp = await startTestProvider();
  });

  afterEach(async () => {
    await tp.close();
  });

  it('BOOK_SUCCESS: books immediately', async () => {
    const hold = await holdFirstSlot(tp);
    await pushScenario(tp, ['BOOK_SUCCESS']);

    const { status, body } = await postTool<BookOutput>(tp, 'book', {
      hold_id: hold.hold_id,
      idempotency_key: 'k-book-success',
    });
    expect(status).toBe(200);
    expect(body.status).toBe('booked');
  });

  it('BOOK_SLOT_TAKEN: 409 slot_taken', async () => {
    const hold = await holdFirstSlot(tp);
    await pushScenario(tp, ['BOOK_SLOT_TAKEN']);

    const { status, body } = await postTool<ToolError>(tp, 'book', {
      hold_id: hold.hold_id,
      idempotency_key: 'k-slot-taken',
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('slot_taken');
  });

  it('TIMEOUT_BOOKED: 504 after the simulated delay, booking actually exists', async () => {
    const hold = await holdFirstSlot(tp);
    await pushScenario(tp, ['TIMEOUT_BOOKED']);
    const key = 'k-timeout-booked';

    const startedMs = Date.now();
    const { status, body } = await postTool<ToolError>(tp, 'book', {
      hold_id: hold.hold_id,
      idempotency_key: key,
    });
    const elapsedMs = Date.now() - startedMs;

    expect(status).toBe(504);
    expect(body.error.code).toBe('timeout');
    expect(elapsedMs).toBeGreaterThanOrEqual(10);

    const statusRes = await postTool<GetBookingStatusOutput>(tp, 'get_booking_status', {
      idempotency_key: key,
    });
    expect(statusRes.status).toBe(200);
    expect(statusRes.body.status).toBe('booked');
  });

  it('TIMEOUT_NOT_BOOKED: 504, status not_booked, retry with the same key can succeed', async () => {
    const hold = await holdFirstSlot(tp);
    await pushScenario(tp, ['TIMEOUT_NOT_BOOKED']);
    const key = 'k-timeout-not-booked';

    const first = await postTool<ToolError>(tp, 'book', { hold_id: hold.hold_id, idempotency_key: key });
    expect(first.status).toBe(504);
    expect(first.body.error.code).toBe('timeout');

    const statusRes = await postTool<GetBookingStatusOutput>(tp, 'get_booking_status', {
      idempotency_key: key,
    });
    expect(statusRes.body.status).toBe('not_booked');

    await pushScenario(tp, ['BOOK_SUCCESS']);
    const retry = await postTool<BookOutput>(tp, 'book', { hold_id: hold.hold_id, idempotency_key: key });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('booked');
  });

  it('HOLD_EXPIRED: 410 hold_expired', async () => {
    const hold = await holdFirstSlot(tp);
    await pushScenario(tp, ['HOLD_EXPIRED']);

    const { status, body } = await postTool<ToolError>(tp, 'book', {
      hold_id: hold.hold_id,
      idempotency_key: 'k-hold-expired',
    });
    expect(status).toBe(410);
    expect(body.error.code).toBe('hold_expired');
  });

  it('PRICE_CHANGES_ON_HOLD: the hold price differs from the search price', async () => {
    await pushScenario(tp, ['PRICE_CHANGES_ON_HOLD']);
    const hold = await holdFirstSlot(tp);
    expect(hold.price).not.toBe(hold.search_price);
  });

  it('CANCEL_503_ONCE: 503 on the first attempt, 200 on retry with the same key', async () => {
    const { booking } = await bookFirstSlot(tp);
    await pushScenario(tp, ['CANCEL_503_ONCE']);
    const key = `cancel-${booking.booking_id}`;

    const first = await postTool<ToolError>(tp, 'cancel', {
      booking_id: booking.booking_id,
      idempotency_key: key,
    });
    expect(first.status).toBe(503);
    expect(first.body.error.code).toBe('transient');

    const retry = await postTool<{ status: string }>(tp, 'cancel', {
      booking_id: booking.booking_id,
      idempotency_key: key,
    });
    expect(retry.status).toBe(200);
    expect(retry.body.status).toBe('cancelled');
  });

  it('CANCEL_OK: 200 immediately', async () => {
    const { booking } = await bookFirstSlot(tp);
    await pushScenario(tp, ['CANCEL_OK']);
    const key = `cancel-${booking.booking_id}`;

    const { status, body } = await postTool<{ status: string }>(tp, 'cancel', {
      booking_id: booking.booking_id,
      idempotency_key: key,
    });
    expect(status).toBe(200);
    expect(body.status).toBe('cancelled');
  });

  it('RESCHEDULE_CONFLICT: 409 with details.alternatives', async () => {
    const { booking } = await bookFirstSlot(tp);
    await pushScenario(tp, ['RESCHEDULE_CONFLICT']);

    const { status, body } = await postTool<ToolError>(tp, 'reschedule', {
      booking_id: booking.booking_id,
      slot: booking.slot,
      idempotency_key: `reschedule-${booking.booking_id}`,
    });
    expect(status).toBe(409);
    expect(body.error.code).toBe('slot_conflict');
    const details = body.error.details as { alternatives: unknown[] };
    expect(Array.isArray(details.alternatives)).toBe(true);
  });

  it('SEARCH_ERROR: 503', async () => {
    await pushScenario(tp, ['SEARCH_ERROR']);
    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();

    const { status, body } = await postTool<ToolError>(tp, 'search_providers', {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    expect(status).toBe(503);
    expect(body.error.code).toBe('search_error');
  });

  it('RANDOM clears pending_scenarios', async () => {
    await pushScenario(tp, ['BOOK_SLOT_TAKEN', 'HOLD_EXPIRED']);
    const beforeState = await getAdminState(tp);
    expect(beforeState.body.pending_scenarios.length).toBeGreaterThan(0);

    await pushScenario(tp, ['RANDOM']);
    const afterState = await getAdminState(tp);
    expect(afterState.body.pending_scenarios).toEqual([]);
  });
});
