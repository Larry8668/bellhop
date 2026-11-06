import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { createMemoryService } from '../../src/memory/service.js';
import { createApiKeyUser, setupTestApp, signUpAndSignIn } from './test-helpers.js';

interface ApiFact {
  id: string;
  key: string;
  value: string;
  kind: string;
  status: string;
}

async function userIdOf(app: Awaited<ReturnType<typeof setupTestApp>>['app'], cookie: string): Promise<string> {
  const res = await app.request('/api/me', { headers: { cookie } });
  expect(res.status).toBe(200);
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

describe('/api/facts', () => {
  it('returns 401 with no credentials', async () => {
    const { app } = await setupTestApp();
    const res = await app.request('/api/facts');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: { code: 'unauthorized', message: 'authentication required' } });
  });

  it('lists non-forgotten facts for the session user in the web fact shape', async () => {
    const setup = await setupTestApp();
    const owner = await signUpAndSignIn(setup.app);
    const other = await signUpAndSignIn(setup.app, { email: 'other@example.com' });
    const ownerId = await userIdOf(setup.app, owner.cookie);
    const otherId = await userIdOf(setup.app, other.cookie);
    const clock = createFakeClock(Date.parse('2026-06-01T00:00:00.000Z'));
    const memory = createMemoryService({ db: setup.db, clock });

    const active = memory.remember(ownerId, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });
    clock.advance(1000);
    const pending = memory.remember(ownerId, { key: 'parking', value: 'street', kind: 'inferred', tags: ['general'] });
    const hidden = memory.remember(ownerId, { key: 'old', value: 'gone', kind: 'explicit', tags: ['general'] });
    memory.forgetById(ownerId, hidden.id);
    memory.remember(otherId, { key: 'budget', value: 'secret', kind: 'explicit', tags: ['general'] });

    const res = await setup.app.request(`/api/facts?user_id=${otherId}`, { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ApiFact[];
    expect(body).toEqual([
      { id: pending.id, key: 'parking', value: 'street', kind: 'inferred', status: 'unconfirmed' },
      { id: active.id, key: 'budget', value: '1000', kind: 'explicit', status: 'active' },
    ]);
    expect(body.some((fact) => fact.value === 'secret' || fact.value === 'gone')).toBe(false);
  });

  it('lets an API key read facts but not change them', async () => {
    const setup = await setupTestApp();
    const { user, apiKey } = await createApiKeyUser(setup.app);
    const ownerId = await userIdOf(setup.app, user.cookie);
    const memory = createMemoryService({
      db: setup.db,
      clock: createFakeClock(Date.parse('2026-06-01T00:00:00.000Z')),
    });
    const fact = memory.remember(ownerId, { key: 'budget', value: '1000', kind: 'explicit' });

    const listed = await setup.app.request('/api/facts', { headers: { authorization: `Bearer ${apiKey}` } });
    expect(listed.status).toBe(200);
    expect(await listed.json()).toEqual([
      { id: fact.id, key: 'budget', value: '1000', kind: 'explicit', status: 'active' },
    ]);

    const patched = await setup.app.request(`/api/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ value: '2000' }),
    });
    expect(patched.status).toBe(403);
    expect(((await patched.json()) as { error: { code: string } }).error.code).toBe('session_required');
    expect(memory.list(ownerId)[0]?.value).toBe('1000');
  });

  it('PATCH makes the fact explicit and active, and rejects another user, a bad body, and a blank value', async () => {
    const setup = await setupTestApp();
    const owner = await signUpAndSignIn(setup.app);
    const other = await signUpAndSignIn(setup.app, { email: 'other-patch@example.com' });
    const ownerId = await userIdOf(setup.app, owner.cookie);
    const memory = createMemoryService({
      db: setup.db,
      clock: createFakeClock(Date.parse('2026-06-01T00:00:00.000Z')),
    });
    const fact = memory.remember(ownerId, { key: 'parking', value: 'street', kind: 'inferred', tags: ['general'] });

    const stolen = await setup.app.request(`/api/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { cookie: other.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'stolen' }),
    });
    expect(stolen.status).toBe(404);
    expect(await stolen.json()).toEqual({ error: { code: 'not_found', message: 'no such fact' } });
    expect(memory.list(ownerId)[0]?.value).toBe('street');

    const injected = await setup.app.request(`/api/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'basement', user_id: 'someone-else' }),
    });
    expect(injected.status).toBe(400);
    expect(((await injected.json()) as { error: { code: string } }).error.code).toBe('bad_request');

    const blank = await setup.app.request(`/api/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: '   ' }),
    });
    expect(blank.status).toBe(400);

    const saved = await setup.app.request(`/api/facts/${fact.id}`, {
      method: 'PATCH',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'basement' }),
    });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toEqual({
      id: fact.id,
      key: 'parking',
      value: 'basement',
      kind: 'explicit',
      status: 'active',
    });

    const missing = await setup.app.request('/api/facts/mem_missing', {
      method: 'PATCH',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ value: 'x' }),
    });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: { code: 'not_found', message: 'no such fact' } });
  });

  it('forget and confirm are scoped to the session user', async () => {
    const setup = await setupTestApp();
    const owner = await signUpAndSignIn(setup.app);
    const other = await signUpAndSignIn(setup.app, { email: 'other-forget@example.com' });
    const ownerId = await userIdOf(setup.app, owner.cookie);
    const { apiKey } = await createApiKeyUser(setup.app);
    const memory = createMemoryService({
      db: setup.db,
      clock: createFakeClock(Date.parse('2026-06-01T00:00:00.000Z')),
    });
    const pending = memory.remember(ownerId, { key: 'parking', value: 'street', kind: 'inferred', tags: ['general'] });
    const active = memory.remember(ownerId, { key: 'budget', value: '1000', kind: 'explicit', tags: ['general'] });

    const keyConfirm = await setup.app.request(`/api/facts/${pending.id}/confirm`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(keyConfirm.status).toBe(403);

    const otherConfirm = await setup.app.request(`/api/facts/${pending.id}/confirm`, {
      method: 'POST',
      headers: { cookie: other.cookie },
    });
    expect(otherConfirm.status).toBe(404);
    expect(await otherConfirm.json()).toEqual({ error: { code: 'not_found', message: 'no such fact' } });

    const confirmed = await setup.app.request(`/api/facts/${pending.id}/confirm`, {
      method: 'POST',
      headers: { cookie: owner.cookie },
    });
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({
      id: pending.id,
      key: 'parking',
      value: 'street',
      kind: 'inferred',
      status: 'active',
    });

    const otherForget = await setup.app.request(`/api/facts/${active.id}/forget`, {
      method: 'POST',
      headers: { cookie: other.cookie },
    });
    expect(otherForget.status).toBe(404);
    expect(memory.list(ownerId).some((fact) => fact.id === active.id)).toBe(true);

    const forgotten = await setup.app.request(`/api/facts/${active.id}/forget`, {
      method: 'POST',
      headers: { cookie: owner.cookie },
    });
    expect(forgotten.status).toBe(200);
    expect(await forgotten.json()).toEqual({ ok: true });

    const listed = (await (await setup.app.request('/api/facts', { headers: { cookie: owner.cookie } })).json()) as ApiFact[];
    expect(listed.map((fact) => fact.id)).toEqual([pending.id]);

    const confirmForgotten = await setup.app.request(`/api/facts/${active.id}/confirm`, {
      method: 'POST',
      headers: { cookie: owner.cookie },
    });
    expect(confirmForgotten.status).toBe(404);
  });
});
