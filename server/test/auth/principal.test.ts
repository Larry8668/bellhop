import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from '../../src/auth/principal.js';
import { setupTestApp, setupTestAuth, signUpAndSignIn } from '../api/test-helpers.js';

describe('resolvePrincipal', () => {
  it('returns null when no session cookie and no API key header are present', async () => {
    const { auth } = await setupTestAuth();

    const principal = await resolvePrincipal(auth, new Headers());

    expect(principal).toBeNull();
  });

  it('returns null for a garbage API key', async () => {
    const { auth } = await setupTestAuth();

    const principal = await resolvePrincipal(auth, new Headers({ 'x-api-key': 'not-a-real-key' }));

    expect(principal).toBeNull();
  });

  // BUGS.md #2 — the plugin default locked a key after 10 verifications / 24 h.
  it('keeps resolving an API key well past 10 verifications', async () => {
    const { app, auth } = await setupTestApp();
    const user = await signUpAndSignIn(app);
    const session = await resolvePrincipal(auth, new Headers({ cookie: user.cookie }));
    const createRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'mcp' }),
    });
    const { key } = (await createRes.json()) as { key: string };

    for (let i = 0; i < 25; i++) {
      const principal = await resolvePrincipal(auth, new Headers({ authorization: `Bearer ${key}` }));
      expect(principal?.userId, `verification #${i + 1}`).toBe(session?.userId);
    }
  });

  it('returns null for a garbage bearer token', async () => {
    const { auth } = await setupTestAuth();

    const principal = await resolvePrincipal(auth, new Headers({ authorization: 'Bearer not-a-real-key' }));

    expect(principal).toBeNull();
  });
});
