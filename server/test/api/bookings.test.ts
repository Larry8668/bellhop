import { describe, expect, it, vi } from 'vitest';
import type { Booking } from '@bellhop/shared/contracts';
import { createApiApp } from '../../src/api/app.js';
import { ProviderError } from '../../src/provider-client/errors.js';
import type { ProviderClient } from '../../src/provider-client/client.js';
import { setupTestAuth, signUpAndSignIn, WEB_ORIGIN } from './test-helpers.js';

function makeBooking(overrides: Partial<Booking> & { when: 'past' | 'upcoming' }): Booking & {
  when: 'past' | 'upcoming';
} {
  return {
    booking_id: 'bk-1',
    user_id: 'user-1',
    provider_id: 'prov-1',
    provider_name: 'QuickFix Plumbing',
    service: 'plumber',
    slot: { start: '2026-01-10T09:00:00.000Z', end: '2026-01-10T10:00:00.000Z' },
    price: 1500,
    currency: 'INR',
    status: 'confirmed',
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

async function buildApp(providerClient: Partial<ProviderClient>) {
  const setup = await setupTestAuth();
  const app = createApiApp({
    auth: setup.auth,
    logger: setup.logger,
    providerClient: providerClient as ProviderClient,
    webOrigin: WEB_ORIGIN,
  });
  return app;
}

describe('GET /api/bookings', () => {
  it('returns 401 with no credentials', async () => {
    const app = await buildApp({ list_bookings: vi.fn() });

    const res = await app.request('/api/bookings');

    expect(res.status).toBe(401);
  });

  it('maps bookings to the web shape, upcoming before past', async () => {
    const past = makeBooking({
      booking_id: 'bk-past',
      slot: { start: '2025-01-01T09:00:00.000Z', end: '2025-01-01T10:00:00.000Z' },
      when: 'past',
    });
    const upcoming = makeBooking({
      booking_id: 'bk-upcoming',
      slot: { start: '2027-01-01T09:00:00.000Z', end: '2027-01-01T10:00:00.000Z' },
      when: 'upcoming',
    });
    const list_bookings = vi.fn().mockResolvedValue({ bookings: [past, upcoming] });
    const app = await buildApp({ list_bookings });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/bookings', { headers: { cookie: user.cookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{ id: string; when: string }>;
    expect(body).toHaveLength(2);
    expect(body[0]?.id).toBe('bk-upcoming');
    expect(body[0]?.when).toBe('upcoming');
    expect(body[1]?.id).toBe('bk-past');
    expect(body[1]?.when).toBe('past');
    expect(body[0]).toMatchObject({
      providerName: 'QuickFix Plumbing',
      service: 'plumber',
      slot: { start: '2027-01-01T09:00:00.000Z', end: '2027-01-01T10:00:00.000Z' },
      price: 1500,
      currency: 'INR',
      status: 'confirmed',
    });
  });

  it('maps a ProviderError with code "timeout" to a 502 envelope', async () => {
    const list_bookings = vi.fn().mockRejectedValue(
      new ProviderError({
        tool: 'list_bookings',
        code: 'timeout',
        message: 'provider timed out',
        status: null,
        timedOut: true,
      }),
    );
    const app = await buildApp({ list_bookings });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/bookings', { headers: { cookie: user.cookie } });

    expect(res.status).toBe(502);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('timeout');
  });

  it('always calls the provider with the session user id, ignoring a different user_id in the query string', async () => {
    const list_bookings = vi.fn().mockResolvedValue({ bookings: [] });
    const app = await buildApp({ list_bookings });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/bookings?user_id=someone-else', {
      headers: { cookie: user.cookie },
    });

    expect(res.status).toBe(200);
    expect(list_bookings).toHaveBeenCalledTimes(1);
    const call = list_bookings.mock.calls[0] as [
      string,
      { user_id: string },
      { requestId?: string }?,
    ];
    const [calledUserId, calledInput, opts] = call;
    expect(calledUserId).not.toBe('someone-else');
    expect(calledInput.user_id).not.toBe('someone-else');
    expect(calledUserId).toBe(calledInput.user_id);
    expect(opts?.requestId).toEqual(expect.any(String));
  });
});
