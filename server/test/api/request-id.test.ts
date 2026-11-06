import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { REQUEST_ID_HEADER } from '@bellhop/shared/contracts';
import type { ProviderClient } from '../../src/provider-client/client.js';
import { setupTestApp, signUpAndSignIn } from './test-helpers.js';

describe('API request id middleware', () => {
  it('generates an id, echoes it on the response, and logs request_id when absent', async () => {
    const lines: string[] = [];
    const { app, logger } = await setupTestApp();
    vi.spyOn(logger, 'info').mockImplementation((obj, msg) => {
      lines.push(JSON.stringify({ obj, msg }));
    });

    const user = await signUpAndSignIn(app);
    const res = await app.request('/api/me', { headers: { cookie: user.cookie } });

    expect(res.status).toBe(200);
    const echoed = res.headers.get(REQUEST_ID_HEADER);
    expect(echoed).toBeTruthy();
    expect(echoed).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const requestLine = lines.find(
      (l) => l.includes('"msg":"request"') && l.includes(`"path":"/api/me"`),
    );
    expect(requestLine).toBeDefined();
    expect(requestLine).toContain(`"request_id":"${echoed}"`);
  });

  it('accepts a valid incoming header and echoes it back', async () => {
    const id = 'ab_c-12';
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/me', {
      headers: { cookie: user.cookie, [REQUEST_ID_HEADER]: id },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(id);
  });

  it('replaces an invalid incoming id and does not echo the bad value', async () => {
    const bad = 'not!valid';
    const list_bookings = vi.fn().mockResolvedValue({ bookings: [] });
    const { app } = await setupTestApp({ providerClient: { list_bookings } as Partial<ProviderClient> });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/bookings', {
      headers: { cookie: user.cookie, [REQUEST_ID_HEADER]: bad },
    });

    expect(res.status).toBe(200);
    const out = res.headers.get(REQUEST_ID_HEADER);
    expect(out).toBeTruthy();
    expect(out).not.toBe(bad);
    expect(list_bookings).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Object),
      expect.objectContaining({ requestId: out }),
    );
  });

  it('passes the same request id to the provider client as the response header', async () => {
    const id = randomUUID();
    const list_bookings = vi.fn().mockResolvedValue({ bookings: [] });
    const { app } = await setupTestApp({ providerClient: { list_bookings } as Partial<ProviderClient> });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/bookings', {
      headers: { cookie: user.cookie, [REQUEST_ID_HEADER]: id },
    });

    expect(res.status).toBe(200);
    expect(res.headers.get(REQUEST_ID_HEADER)).toBe(id);
    expect(list_bookings).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ user_id: expect.any(String) }),
      { requestId: id },
    );
  });
});
