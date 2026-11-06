import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ADMIN_PATHS,
  type BookOutput,
  type HoldSlotOutput,
  type ListBookingsOutput,
  type ProviderSummary,
  type ToolError,
} from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '../../src/testing.js';
import { bookFirstSlot, holdFirstSlot, postTool, pushScenario, TEST_USER } from './helpers.js';

describe('admin disabled', () => {
  it('/__admin/state is a plain 404 when adminEnabled is false', async () => {
    const tp = await startTestProvider({ adminEnabled: false });
    try {
      const res = await fetch(`${tp.url}${ADMIN_PATHS.state}`);
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: { code: string } };
      expect(body.error.code).toBe('not_found');
    } finally {
      await tp.close();
    }
  });
});

describe('idempotency over HTTP', () => {
  let tp: TestProvider;

  beforeEach(async () => {
    tp = await startTestProvider();
  });

  afterEach(async () => {
    await tp.close();
  });

  it('same idempotency key reused with a different hold -> 409 idempotency_mismatch', async () => {
    const hold1 = await holdFirstSlot(tp);
    await pushScenario(tp, ['BOOK_SUCCESS']);
    const key = 'shared-key';

    const first = await postTool<BookOutput>(tp, 'book', { hold_id: hold1.hold_id, idempotency_key: key });
    expect(first.status).toBe(200);

    // A different service/area so the second hold is on an independent slot.
    const search = await postTool<{ providers: ProviderSummary[] }>(tp, 'search_providers', {
      service: 'electrician',
      area: 'Koramangala',
      date_range: {
        from: tp.clock.now().toISOString(),
        to: new Date(tp.clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    const provider2 = search.body.providers[0]!;
    const hold2Res = await postTool<HoldSlotOutput>(tp, 'hold_slot', {
      provider_id: provider2.id,
      slot: provider2.slots[0]!,
    });
    const hold2 = hold2Res.body.hold;

    const second = await postTool<ToolError>(tp, 'book', { hold_id: hold2.hold_id, idempotency_key: key });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('idempotency_mismatch');
  });
});

describe('provider-side booking cancellation (POST /__admin/cancel-booking/:id)', () => {
  let tp: TestProvider;

  beforeEach(async () => {
    tp = await startTestProvider();
  });

  afterEach(async () => {
    await tp.close();
  });

  it('cancels the booking, visible immediately in list_bookings', async () => {
    const { booking } = await bookFirstSlot(tp);

    const res = await fetch(`${tp.url}${ADMIN_PATHS.cancelBooking(booking.booking_id)}`, { method: 'POST' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { booking: { status: string } };
    expect(body.booking.status).toBe('cancelled');

    const list = await postTool<ListBookingsOutput>(tp, 'list_bookings', { user_id: TEST_USER });
    const found = list.body.bookings.find((b) => b.booking_id === booking.booking_id);
    expect(found?.status).toBe('cancelled');
  });

  it('404 booking_not_found for an unknown booking id', async () => {
    const res = await fetch(`${tp.url}${ADMIN_PATHS.cancelBooking('bk_does_not_exist')}`, { method: 'POST' });
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('booking_not_found');
  });
});
