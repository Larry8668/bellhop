import { createLogger } from '@bellhop/shared/logger';
import type { Slot } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '@bellhop/provider/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createProviderAdminClient,
  createProviderClient,
  ProviderError,
} from '../../src/provider-client/index.js';

/** Markers from provider seed (`provider/src/db/seed.ts`) — injection review text must contain one of these. */
const INJECTION_MARKERS = [
  'SYSTEM:',
  '[assistant:',
  'Note to AI agents',
  'tool: approve=true',
] as const;

function hasInjectionReview(text: string): boolean {
  return INJECTION_MARKERS.some((m) => text.includes(m));
}

function slotsEqual(a: Slot, b: Slot): boolean {
  return a.start === b.start && a.end === b.end;
}

/**
 * Plan §16 global invariants we can assert from provider admin state + client headers in this slice:
 * - At most one booking row per idempotency key on the provider.
 * - No cross-user leak: other user never sees booking rows for primary user (asserted in dedicated it()).
 */
function assertGlobalInvariantsFromAdminState(
  state: Awaited<ReturnType<ReturnType<typeof createProviderAdminClient>['state']>>,
): void {
  const successfulBookKeys = state.idempotency
    .filter((row) => row.tool === 'book' && row.status === 200)
    .map((row) => row.key);
  expect(new Set(successfulBookKeys).size).toBe(successfulBookKeys.length);
}

describe('provider-client e2e (real mock provider)', () => {
  const silent = createLogger({ name: 'provider-e2e', level: 'silent' });
  const primaryUser = 'user-phase1-e2e';

  let tp: TestProvider;
  let client: ReturnType<typeof createProviderClient>;
  let admin: ReturnType<typeof createProviderAdminClient>;

  beforeAll(async () => {
    tp = await startTestProvider({ seed: 42, timeoutDelayMs: 100 });
    client = createProviderClient({ baseUrl: tp.url, timeoutMs: 50, logger: silent });
    admin = createProviderAdminClient({ baseUrl: tp.url });
  });

  afterAll(async () => {
    await tp.close();
  });

  it('phase 1 happy path + S16 reschedule + S15 cancel 503 + S13 idempotent replay + cross-user + H2 hold expiry + SEARCH_ERROR', async () => {
    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();

    const search = await client.search_providers(primaryUser, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    expect(search.providers.length).toBeGreaterThanOrEqual(3);
    expect(search.providers.length).toBeLessThanOrEqual(8);
    expect(search.providers.every((p) => p.service === 'plumber')).toBe(true);
    expect(search.providers.every((p) => p.area === 'Indiranagar')).toBe(true);

    let injectionProviderId: string | undefined;
    for (const p of search.providers) {
      const detail = await client.get_provider(primaryUser, { provider_id: p.id });
      expect(detail.provider.reviews.length).toBeGreaterThan(0);
      if (detail.provider.reviews.some((r) => hasInjectionReview(r.text))) {
        injectionProviderId = p.id;
        break;
      }
    }
    expect(injectionProviderId).toBeDefined();
    const providerId = injectionProviderId as string;

    const chosen = search.providers.find((p) => p.id === providerId)!;
    expect(chosen.slots.length).toBeGreaterThanOrEqual(2);
    const slotA = chosen.slots[0]!;
    const slotB = chosen.slots.find((s) => !slotsEqual(s, slotA));
    expect(slotB).toBeDefined();

    const holdOut = await client.hold_slot(primaryUser, {
      provider_id: providerId,
      slot: slotA,
    });
    const hold = holdOut.hold;
    expect(hold.provider_id).toBe(providerId);
    expect(hold.slot).toEqual(slotA);
    expect(Number.isInteger(hold.price)).toBe(true);
    expect(Number.isInteger(hold.search_price)).toBe(true);

    const expiresAtMs = Date.parse(hold.expires_at);
    expect(expiresAtMs - tp.clock.nowMs()).toBe(10 * 60_000);

    await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });
    const book1 = await client.book(primaryUser, { hold_id: hold.hold_id, idempotency_key: 'k1' });
    expect(book1.booking.status).toBe('confirmed');
    const bookingId = book1.booking.booking_id;

    const statusByHold = await client.get_booking_status(primaryUser, { hold_id: hold.hold_id });
    expect(statusByHold.status).toBe('booked');
    expect(statusByHold.booking?.booking_id).toBe(bookingId);

    const statusByKey = await client.get_booking_status(primaryUser, { idempotency_key: 'k1' });
    expect(statusByKey.status).toBe('booked');
    expect(statusByKey.booking?.booking_id).toBe(bookingId);

    const rescheduleOut = await client.reschedule(primaryUser, {
      booking_id: bookingId,
      slot: slotB!,
      idempotency_key: 'reschedule-k1',
    });
    expect(rescheduleOut.status).toBe('rescheduled');
    expect(rescheduleOut.booking.slot).toEqual(slotB!);
    expect(slotsEqual(rescheduleOut.previous_slot, slotA)).toBe(true);

    await admin.scenario({ outcomes: ['CANCEL_503_ONCE'] });
    await expect(
      client.cancel(primaryUser, { booking_id: bookingId, idempotency_key: 'k2' }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      tool: 'cancel',
      code: 'transient',
      status: 503,
    });

    const cancelFinal = await client.cancel(primaryUser, {
      booking_id: bookingId,
      idempotency_key: 'k2',
    });
    expect(cancelFinal.status).toBe('cancelled');
    expect(cancelFinal.booking.status).toBe('cancelled');

    const list = await client.list_bookings(primaryUser, { user_id: primaryUser });
    const listed = list.bookings.find((b) => b.booking_id === bookingId);
    expect(listed?.status).toBe('cancelled');

    const dupBook = await client.book(primaryUser, { hold_id: hold.hold_id, idempotency_key: 'k1' });
    expect(dupBook.booking.booking_id).toBe(bookingId);

    await expect(
      client.book(primaryUser, {
        hold_id: 'hold-nonexistent-for-k1',
        idempotency_key: 'k1',
      }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'idempotency_mismatch',
      status: 409,
    });

    const otherStatus = await client.get_booking_status('other-user', { hold_id: hold.hold_id });
    expect(otherStatus.status).toBe('not_booked');
    expect(otherStatus.booking).toBeNull();

    await expect(
      client.cancel('other-user', { booking_id: bookingId, idempotency_key: 'k-cross' }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'booking_not_found',
      status: 404,
    });

    const holdExpire = await client.hold_slot(primaryUser, {
      provider_id: providerId,
      slot: slotA,
    });
    await admin.clock({ advance_ms: 11 * 60_000 });
    await expect(
      client.book(primaryUser, {
        hold_id: holdExpire.hold.hold_id,
        idempotency_key: 'k-hold-expired-e2e',
      }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'hold_expired',
      status: 410,
    });

    await admin.scenario({ outcomes: ['SEARCH_ERROR'] });
    await expect(
      client.search_providers(primaryUser, {
        service: 'plumber',
        area: 'Indiranagar',
        date_range: { from, to },
      }),
    ).rejects.toMatchObject({
      name: 'ProviderError',
      code: 'search_error',
      status: 503,
    });

    const searchAfter = await client.search_providers(primaryUser, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    expect(searchAfter.providers.length).toBeGreaterThanOrEqual(3);

    const state = await admin.state();
    assertGlobalInvariantsFromAdminState(state);
    expect(state.bookings.some((b) => b.booking_id === bookingId)).toBe(true);
  });

  it('S09 timeout after success — client timeout surfaces timedOut; status verifies booked', async () => {
    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { providers } = await client.search_providers(primaryUser, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    const p0 = providers[0]!;
    const holdOut = await client.hold_slot(primaryUser, {
      provider_id: p0.id,
      slot: p0.slots[0]!,
    });

    await admin.scenario({ outcomes: ['TIMEOUT_BOOKED'] });
    try {
      await client.book(primaryUser, { hold_id: holdOut.hold.hold_id, idempotency_key: 'k3' });
      expect.fail('expected ProviderError timeout');
    } catch (e) {
      expect(ProviderError.isProviderError(e, 'timeout')).toBe(true);
      if (ProviderError.isProviderError(e)) {
        expect(e.timedOut).toBe(true);
        expect(e.status).toBeNull();
      }
    }

    const st = await client.get_booking_status(primaryUser, { idempotency_key: 'k3' });
    expect(st.status).toBe('booked');
    expect(st.booking).not.toBeNull();
  });

  it('S10 timeout not booked — retry with same key after BOOK_SUCCESS', async () => {
    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const { providers } = await client.search_providers(primaryUser, {
      service: 'plumber',
      area: 'Indiranagar',
      date_range: { from, to },
    });
    const p0 = providers[0]!;
    const slot = p0.slots.length > 1 ? p0.slots[1]! : p0.slots[0]!;
    const holdOut = await client.hold_slot(primaryUser, {
      provider_id: p0.id,
      slot,
    });

    await admin.scenario({ outcomes: ['TIMEOUT_NOT_BOOKED'] });
    try {
      await client.book(primaryUser, { hold_id: holdOut.hold.hold_id, idempotency_key: 'k4' });
      expect.fail('expected ProviderError timeout');
    } catch (e) {
      expect(ProviderError.isProviderError(e, 'timeout')).toBe(true);
    }

    const st1 = await client.get_booking_status(primaryUser, { idempotency_key: 'k4' });
    expect(st1.status).toBe('not_booked');

    await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });
    const book = await client.book(primaryUser, {
      hold_id: holdOut.hold.hold_id,
      idempotency_key: 'k4',
    });
    expect(book.booking.booking_id).toBeTruthy();

    const st2 = await client.get_booking_status(primaryUser, { idempotency_key: 'k4' });
    expect(st2.status).toBe('booked');
    expect(st2.booking?.booking_id).toBe(book.booking.booking_id);
  });
});
