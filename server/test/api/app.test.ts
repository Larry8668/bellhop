import { describe, expect, it } from 'vitest';
import { setupTestApp, signUpAndSignIn } from './test-helpers.js';

describe('GET /api/health', () => {
  it('reports ok', async () => {
    const { app } = await setupTestApp();

    const res = await app.request('/api/health');

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

describe('session auth: sign-up, sign-in, /api/me', () => {
  it('signs up and signs in, then resolves /api/me from the session cookie', async () => {
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/me', { headers: { cookie: user.cookie } });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { user: { id: string; email: string; name: string }; via: string };
    expect(body.via).toBe('session');
    expect(body.user.email).toBe(user.email);
    expect(body.user.name).toBe(user.name);
    expect(body.user.id).toEqual(expect.any(String));
  });

  it('rejects /api/me with no credentials', async () => {
    const { app } = await setupTestApp();

    const res = await app.request('/api/me');

    expect(res.status).toBe(401);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('unauthorized');
  });

  it('rejects /api/me with a garbage x-api-key', async () => {
    const { app } = await setupTestApp();

    const res = await app.request('/api/me', { headers: { 'x-api-key': 'definitely-not-a-key' } });

    expect(res.status).toBe(401);
  });
});

describe('API keys', () => {
  it('creates a key from a session, then authenticates /api/me with it as via: api_key', async () => {
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    const createRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'cli key' }),
    });

    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string; key: string; createdAt: string };
    expect(created.name).toBe('cli key');
    expect(created.key).toEqual(expect.any(String));
    expect(created.key.length).toBeGreaterThan(10);

    const meRes = await app.request('/api/me', { headers: { 'x-api-key': created.key } });
    expect(meRes.status).toBe(200);
    const meBody = (await meRes.json()) as { user: { email: string }; via: string };
    expect(meBody.via).toBe('api_key');
    expect(meBody.user.email).toBe(user.email);

    // Also accepted via the Authorization: Bearer form.
    const bearerRes = await app.request('/api/me', { headers: { authorization: `Bearer ${created.key}` } });
    expect(bearerRes.status).toBe(200);
  });

  it('rejects POST /api/keys when authenticated only with an API key', async () => {
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    const createRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'first key' }),
    });
    const { key } = (await createRes.json()) as { key: string };

    const secondCreateRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'second key' }),
    });

    expect(secondCreateRes.status).toBe(403);
  });

  it('lists keys for the user without returning key material', async () => {
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'key one' }),
    });

    const listRes = await app.request('/api/keys', { headers: { cookie: user.cookie } });
    expect(listRes.status).toBe(200);
    const body = (await listRes.json()) as { keys: Array<Record<string, unknown>> };
    expect(body.keys).toHaveLength(1);
    expect(body.keys[0]?.name).toBe('key one');
    expect(body.keys[0]).not.toHaveProperty('key');
  });

  it('revokes a key by id, after which it no longer authenticates', async () => {
    const { app } = await setupTestApp();
    const user = await signUpAndSignIn(app);

    const createRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'to revoke' }),
    });
    const created = (await createRes.json()) as { id: string; key: string };

    const deleteRes = await app.request(`/api/keys/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: user.cookie },
    });
    expect(deleteRes.status).toBe(200);

    const meRes = await app.request('/api/me', { headers: { 'x-api-key': created.key } });
    expect(meRes.status).toBe(401);
  });

  it("does not let user B's session delete user A's key", async () => {
    const { app } = await setupTestApp();
    const userA = await signUpAndSignIn(app);
    const userB = await signUpAndSignIn(app);

    const createRes = await app.request('/api/keys', {
      method: 'POST',
      headers: { cookie: userA.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: "A's key" }),
    });
    const created = (await createRes.json()) as { id: string; key: string };

    const deleteRes = await app.request(`/api/keys/${created.id}`, {
      method: 'DELETE',
      headers: { cookie: userB.cookie },
    });
    expect([403, 404]).toContain(deleteRes.status);

    // The key must still work — user B's attempt had no effect.
    const meRes = await app.request('/api/me', { headers: { 'x-api-key': created.key } });
    expect(meRes.status).toBe(200);
  });
});
