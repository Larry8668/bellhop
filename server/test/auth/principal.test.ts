import { describe, expect, it } from 'vitest';
import { resolvePrincipal } from '../../src/auth/principal.js';
import { setupTestAuth } from '../api/test-helpers.js';

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

  it('returns null for a garbage bearer token', async () => {
    const { auth } = await setupTestAuth();

    const principal = await resolvePrincipal(auth, new Headers({ authorization: 'Bearer not-a-real-key' }));

    expect(principal).toBeNull();
  });
});
