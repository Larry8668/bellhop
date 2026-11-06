import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Slot } from '@bellhop/shared/contracts';
import { createLogger } from '@bellhop/shared/logger';
import { startTestProvider, type TestProvider } from '@bellhop/provider/testing';
import { createApiApp } from '../../src/api/app.js';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { createProviderAdminClient, createProviderClient } from '../../src/provider-client/index.js';
import { createApiKeyUser, setupTestAuth, signUpAndSignIn, WEB_ORIGIN } from './test-helpers.js';

const LIMITS = { statusChecks: 3, retriesPerTool: 2 } as const;

describe('proposals API (Phase 2 wave 3c)', () => {
  let tp: TestProvider;
  let admin: ReturnType<typeof createProviderAdminClient>;
  let providerClient: ReturnType<typeof createProviderClient>;

  beforeAll(async () => {
    tp = await startTestProvider({ seed: 42, timeoutDelayMs: 50 });
    admin = createProviderAdminClient({ baseUrl: tp.url });
    await admin.reset({ seed: 42 });
    const silentLogger = createLogger({ name: 'proposals-api-test', level: 'silent' });
    providerClient = createProviderClient({ baseUrl: tp.url, timeoutMs: 5000, logger: silentLogger });
  });

  afterAll(async () => {
    await tp.close();
  });

  async function makeApp() {
    const authSetup = await setupTestAuth();
    const tracesDir = mkdtempSync(path.join(tmpdir(), 'bellhop-proposals-api-'));
    const queue = createUserQueue({ logger: authSetup.logger });
    const app = createApiApp({
      auth: authSetup.auth,
      logger: authSetup.logger,
      providerClient,
      webOrigin: WEB_ORIGIN,
      db: authSetup.db,
      // Must match the test provider's clock so hold expiry checks agree with hold_expires_at (plan §7).
      clock: tp.clock,
      limits: LIMITS,
      tracesDir,
      queue,
    });
    return { app, ...authSetup };
  }

  it('happy path: propose book → list has hash → approve → booked once on provider', async () => {
    const { app } = await makeApp();
    const user = await signUpAndSignIn(app);
    const userId = (await (await app.request('/api/me', { headers: { cookie: user.cookie } })).json()) as {
      user: { id: string };
    };

    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const search = await providerClient.search_providers(
      userId.user.id,
      { service: 'plumber', area: 'Indiranagar', date_range: { from, to } },
      { requestId: 't-proposals-1' },
    );
    const p = search.providers[0];
    if (!p) throw new Error('expected provider');
    const slot: Slot = p.slots[0] as Slot;

    const proposeRes = await app.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: p.id,
        service: 'plumber',
        slot,
      }),
    });
    expect(proposeRes.status).toBe(200);
    const { proposal } = (await proposeRes.json()) as { proposal: { id: string; hash: string } };

    const listRes = await app.request('/api/proposals', { headers: { cookie: user.cookie } });
    expect(listRes.status).toBe(200);
    const listBody = (await listRes.json()) as { proposals: Array<{ id: string; hash: string }> };
    expect(listBody.proposals).toHaveLength(1);
    expect(listBody.proposals[0]?.hash).toBe(proposal.hash);

    await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });
    const approveRes = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(approveRes.status).toBe(200);
    const approved = (await approveRes.json()) as {
      outcome: { kind: string; replayed?: boolean };
      message: string;
    };
    expect(approved.outcome.kind).toBe('booked');
    expect(approved.outcome.replayed).toBe(false);

    const state = await admin.state();
    expect(state.bookings.filter((b) => b.user_id === userId.user.id)).toHaveLength(1);
  });

  it('wrong hash → 409 hash_mismatch and no booking; second approve replays with one booking', async () => {
    await admin.reset({ seed: 43 });
    const { app } = await makeApp();
    const user = await signUpAndSignIn(app);
    const me = (await (
      await app.request('/api/me', { headers: { cookie: user.cookie } })
    ).json()) as { user: { id: string } };

    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const search = await providerClient.search_providers(
      me.user.id,
      { service: 'plumber', area: 'Indiranagar', date_range: { from, to } },
      { requestId: 't-proposals-2' },
    );
    const p = search.providers[0];
    if (!p) throw new Error('expected provider');
    const slot: Slot = p.slots[0] as Slot;

    const proposeRes = await app.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: p.id,
        service: 'plumber',
        slot,
      }),
    });
    const { proposal } = (await proposeRes.json()) as { proposal: { id: string; hash: string } };

    const badApprove = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      // A 64-hex string so it passes the request-schema format check and reaches
      // the business-logic hash comparison (plan §7 gate fix item 6).
      body: JSON.stringify({ hash: '0'.repeat(64) }),
    });
    expect(badApprove.status).toBe(409);
    const badBody = (await badApprove.json()) as { error: { code: string } };
    expect(badBody.error.code).toBe('hash_mismatch');
    let state = await admin.state();
    expect(state.bookings.filter((b) => b.user_id === me.user.id)).toHaveLength(0);

    await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });
    const firstOk = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(firstOk.status).toBe(200);
    const firstBody = (await firstOk.json()) as { outcome: { kind: string; replayed?: boolean } };
    expect(firstBody.outcome.kind).toBe('booked');
    expect(firstBody.outcome.replayed).toBe(false);

    const secondOk = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(secondOk.status).toBe(200);
    const secondBody = (await secondOk.json()) as { outcome: { kind: string; replayed: boolean } };
    expect(secondBody.outcome.kind).toBe('booked');
    expect(secondBody.outcome.replayed).toBe(true);

    // A repeated Confirm with a different hash is not a replay: 409, no execution.
    const wrongReplay = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: 'f'.repeat(64) }),
    });
    expect(wrongReplay.status).toBe(409);

    state = await admin.state();
    expect(state.bookings.filter((b) => b.user_id === me.user.id)).toHaveLength(1);
  });

  it('decline clears pending list', async () => {
    await admin.reset({ seed: 44 });
    const { app } = await makeApp();
    const user = await signUpAndSignIn(app);

    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const me = (await (
      await app.request('/api/me', { headers: { cookie: user.cookie } })
    ).json()) as { user: { id: string } };
    const search = await providerClient.search_providers(
      me.user.id,
      { service: 'plumber', area: 'Indiranagar', date_range: { from, to } },
      { requestId: 't-proposals-3' },
    );
    const p = search.providers[0];
    if (!p) throw new Error('expected provider');
    const slot: Slot = p.slots[0] as Slot;

    const proposeRes = await app.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: p.id,
        service: 'plumber',
        slot,
      }),
    });
    const { proposal } = (await proposeRes.json()) as { proposal: { id: string } };

    const declineRes = await app.request(`/api/proposals/${proposal.id}/decline`, {
      method: 'POST',
      headers: { cookie: user.cookie },
    });
    expect(declineRes.status).toBe(200);
    expect(await declineRes.json()).toEqual({ ok: true });

    const listRes = await app.request('/api/proposals', { headers: { cookie: user.cookie } });
    const listBody = (await listRes.json()) as { proposals: unknown[] };
    expect(listBody.proposals).toHaveLength(0);
  });

  it('rejects strict body with user_id; cross-user proposal id returns 404', async () => {
    await admin.reset({ seed: 45 });
    const { app: appA } = await makeApp();
    const alice = await signUpAndSignIn(appA);
    const aliceMe = (await (
      await appA.request('/api/me', { headers: { cookie: alice.cookie } })
    ).json()) as { user: { id: string } };

    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const search = await providerClient.search_providers(
      aliceMe.user.id,
      { service: 'plumber', area: 'Indiranagar', date_range: { from, to } },
      { requestId: 't-proposals-4' },
    );
    const p = search.providers[0];
    if (!p) throw new Error('expected provider');
    const slot: Slot = p.slots[0] as Slot;

    const strictFail = await appA.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: p.id,
        service: 'plumber',
        slot,
        user_id: 'evil',
      }),
    });
    expect(strictFail.status).toBe(400);

    const proposeRes = await appA.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: alice.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: p.id,
        service: 'plumber',
        slot,
      }),
    });
    const { proposal } = (await proposeRes.json()) as { proposal: { id: string; hash: string } };

    const { app: appB } = await makeApp();
    const bob = await signUpAndSignIn(appB);

    const approve404 = await appB.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: bob.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(approve404.status).toBe(404);

    const decline404 = await appB.request(`/api/proposals/${proposal.id}/decline`, {
      method: 'POST',
      headers: { cookie: bob.cookie },
    });
    expect(decline404.status).toBe(404);
  });

  it('returns 401 when unauthenticated', async () => {
    const { app } = await makeApp();
    const res = await app.request('/api/proposals', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action: 'book',
        provider_id: 'x',
        service: 'plumber',
        slot: { start: '2026-11-10T09:00:00.000Z', end: '2026-11-10T10:00:00.000Z' },
      }),
    });
    expect(res.status).toBe(401);
  });

  it('approvals require a browser session: an API key gets 403 and books nothing; the session can still approve', async () => {
    await admin.reset({ seed: 46 });
    const { app } = await makeApp();
    const { user, apiKey } = await createApiKeyUser(app);
    const me = (await (
      await app.request('/api/me', { headers: { cookie: user.cookie } })
    ).json()) as { user: { id: string } };

    const from = tp.clock.now().toISOString();
    const to = new Date(tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
    const search = await providerClient.search_providers(
      me.user.id,
      { service: 'plumber', area: 'Indiranagar', date_range: { from, to } },
      { requestId: 't-proposals-session-gate' },
    );
    const p = search.providers[0];
    if (!p) throw new Error('expected provider');
    const slot: Slot = p.slots[0] as Slot;

    // Creating a proposal is also session-only (plan §7 gate fix item 1).
    const apiKeyPropose = await app.request('/api/proposals', {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'book', provider_id: p.id, service: 'plumber', slot }),
    });
    expect(apiKeyPropose.status).toBe(403);
    expect(((await apiKeyPropose.json()) as { error: { code: string } }).error.code).toBe('session_required');

    const proposeRes = await app.request('/api/proposals', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ action: 'book', provider_id: p.id, service: 'plumber', slot }),
    });
    expect(proposeRes.status).toBe(200);
    const { proposal } = (await proposeRes.json()) as { proposal: { id: string; hash: string } };

    await admin.scenario({ outcomes: ['BOOK_SUCCESS'] });

    const apiKeyApprove = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(apiKeyApprove.status).toBe(403);
    expect(((await apiKeyApprove.json()) as { error: { code: string } }).error.code).toBe('session_required');

    const apiKeyDecline = await app.request(`/api/proposals/${proposal.id}/decline`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}` },
    });
    expect(apiKeyDecline.status).toBe(403);
    expect(((await apiKeyDecline.json()) as { error: { code: string } }).error.code).toBe('session_required');

    let state = await admin.state();
    expect(state.bookings.filter((b) => b.user_id === me.user.id)).toHaveLength(0);

    const sessionApprove = await app.request(`/api/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ hash: proposal.hash }),
    });
    expect(sessionApprove.status).toBe(200);
    expect(((await sessionApprove.json()) as { outcome: { kind: string } }).outcome.kind).toBe('booked');

    state = await admin.state();
    expect(state.bookings.filter((b) => b.user_id === me.user.id)).toHaveLength(1);
  });
});
