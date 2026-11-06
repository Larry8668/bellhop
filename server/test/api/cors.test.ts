import { describe, expect, it } from 'vitest';
import { setupTestApp, WEB_ORIGIN } from './test-helpers.js';

describe('CORS on /api/*', () => {
  it('echoes the web origin and allows credentials on a preflight request', async () => {
    const { app } = await setupTestApp();

    const res = await app.request('/api/me', {
      method: 'OPTIONS',
      headers: {
        origin: WEB_ORIGIN,
        'access-control-request-method': 'GET',
      },
    });

    expect(res.headers.get('access-control-allow-origin')).toBe(WEB_ORIGIN);
    expect(res.headers.get('access-control-allow-credentials')).toBe('true');
  });
});
