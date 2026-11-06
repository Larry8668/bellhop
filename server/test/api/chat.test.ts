import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateText, type LanguageModel } from 'ai';
import type Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { systemClock } from '@bellhop/shared/clock';
import { createApiApp } from '../../src/api/app.js';
import { newId } from '../../src/core/ids.js';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { createBookingsRepo } from '../../src/core/repo/bookings.repo.js';
import { createConversationsRepo } from '../../src/core/repo/conversations.repo.js';
import { createMessagesRepo } from '../../src/core/repo/messages.repo.js';
import type { AppBooking } from '../../src/core/types.js';
import { createEventBus, type EventBus } from '../../src/events/bus.js';
import { scriptedModel, textStep } from '../../src/harness/scripted-model.js';
import type { ProviderClient } from '../../src/provider-client/client.js';
import {
  runTurn as placeholderRunTurn,
  type HarnessMemory,
  type RunTurn,
  type TurnEvent,
} from '../../src/wiring/deps.js';
import {
  apiWiring,
  createApiKeyUser,
  emptyMemory,
  setupTestAuth,
  signUpAndSignIn,
  WEB_ORIGIN,
} from './test-helpers.js';

const ASSISTANT_REPLY = 'Thursday at 10 works. I will hold that slot.';
const noopProvider = { list_bookings: () => Promise.resolve({ bookings: [] }) } as unknown as ProviderClient;

function persistingRunTurn(expectedModel: LanguageModel, expectedMemory: HarnessMemory): RunTurn {
  return async (deps, input) => {
    if (deps.model !== expectedModel) throw new Error('runTurn was not given the injected model');
    if (deps.memory !== expectedMemory) throw new Error('runTurn was not given the injected memory');
    if (deps.limits.modelCalls !== 8) throw new Error('runTurn was not given turn limits');
    deps.memory.selectForContext(input.userId, {});

    const generated = await generateText({ model: deps.model, prompt: input.text });
    const userAt = deps.clock.now().toISOString();
    const assistantAt = new Date(deps.clock.nowMs() + 1).toISOString();
    const conversation = createConversationsRepo(deps.db).ensureConversation(input.userId, userAt);
    const messages = createMessagesRepo(deps.db);
    messages.append({
      id: newId('msg'),
      conversation_id: conversation.id,
      user_id: input.userId,
      role: 'user',
      text: input.text,
      proposal_id: null,
      created_at: userAt,
    });
    messages.append({
      id: newId('msg'),
      conversation_id: conversation.id,
      user_id: input.userId,
      role: 'assistant',
      text: generated.text,
      proposal_id: 'prop_from_row',
      created_at: assistantAt,
    });
    deps.onEvent?.({ ts: assistantAt, type: 'turn_end', summary: 'turn finished' });
    return { reply: generated.text, exit: 'proposed', proposalId: 'prop_from_result', runId: 'run_test' };
  };
}

interface ChatHarness {
  app: ReturnType<typeof createApiApp>;
  db: Database.Database;
  bus: EventBus;
  memory: HarnessMemory;
  cancelBooking: ReturnType<typeof vi.fn>;
  tick: ReturnType<typeof vi.fn>;
}

async function setupChat(
  options: {
    runTurn?: RunTurn;
    devRoutes?: boolean;
    cancelImpl?: (bookingId: string) => Promise<void>;
    tickImpl?: () => Promise<void>;
  } = {},
): Promise<ChatHarness> {
  const authSetup = await setupTestAuth();
  const tracesDir = mkdtempSync(path.join(tmpdir(), 'bellhop-chat-'));
  const queue = createUserQueue({ logger: authSetup.logger });
  const bus = createEventBus();
  const model = scriptedModel([textStep(ASSISTANT_REPLY)]);
  const memory = emptyMemory();
  const cancelBooking = vi.fn(options.cancelImpl ?? (async () => {}));
  const tick = vi.fn(options.tickImpl ?? (async () => {}));
  const app = createApiApp({
    auth: authSetup.auth,
    logger: authSetup.logger,
    providerClient: noopProvider,
    webOrigin: WEB_ORIGIN,
    db: authSetup.db,
    clock: systemClock,
    limits: { statusChecks: 3, retriesPerTool: 2 },
    tracesDir,
    queue,
    ...apiWiring({
      model,
      memory,
      bus,
      runTurn: options.runTurn ?? persistingRunTurn(model, memory),
      devRoutes: options.devRoutes ?? true,
      providerAdmin: { cancelBooking },
      proactive: { tick, start: () => () => {} },
    }),
  });
  return { app, db: authSetup.db, bus, memory, cancelBooking, tick };
}

async function userIdOf(app: ReturnType<typeof createApiApp>, cookie: string): Promise<string> {
  const res = await app.request('/api/me', { headers: { cookie } });
  const body = (await res.json()) as { user: { id: string } };
  return body.user.id;
}

function ownedBooking(userId: string, bookingId: string): AppBooking {
  return {
    booking_id: bookingId,
    user_id: userId,
    provider_id: 'prov_1',
    provider_name: 'QuickFix',
    service: 'plumber',
    slot: { start: '2026-12-01T09:00:00.000Z', end: '2026-12-01T10:00:00.000Z' },
    price: 500,
    currency: 'INR',
    status: 'confirmed',
    synced_at: '2026-11-07T00:00:00.000Z',
  };
}

async function collectSse(res: Response, until: (buf: string) => boolean): Promise<string> {
  const reader = res.body?.getReader();
  if (reader === undefined) throw new Error('sse response has no body');
  const decoder = new TextDecoder();
  let buf = '';
  const timeout = setTimeout(() => {
    void reader.cancel();
  }, 2000);
  try {
    while (!until(buf)) {
      const next = await reader.read();
      if (next.done) break;
      buf += decoder.decode(next.value, { stream: true });
    }
    return buf;
  } finally {
    clearTimeout(timeout);
    await reader.cancel().catch(() => undefined);
  }
}

describe('chat API', () => {
  it('placeholder runTurn rejects until the harness branch is merged', async () => {
    await expect(placeholderRunTurn(undefined as never, { userId: 'u', text: 'hi' })).rejects.toThrow(/not wired/);
  });

  it('send persists the assistant reply from the scripted model and lists messages oldest first', async () => {
    const { app, bus, memory } = await setupChat();
    const selectForContext = vi.spyOn(memory, 'selectForContext');
    const user = await signUpAndSignIn(app);
    const userId = await userIdOf(app, user.cookie);
    const seen: TurnEvent[] = [];
    bus.subscribe(userId, (event) => {
      seen.push(event);
    });

    const sendRes = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Book a plumber Thursday at 10' }),
    });

    expect(sendRes.status).toBe(200);
    const assistant = (await sendRes.json()) as {
      id: string;
      role: string;
      text: string;
      createdAt: string;
      proposalId: string | null;
    };
    expect(assistant).toMatchObject({
      role: 'assistant',
      text: ASSISTANT_REPLY,
      proposalId: 'prop_from_row',
    });
    expect(assistant.id.length).toBeGreaterThan(0);
    expect(assistant.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(selectForContext).toHaveBeenCalledWith(userId, {});
    expect(seen).toEqual([expect.objectContaining({ type: 'turn_end', summary: 'turn finished' })]);

    const listRes = await app.request('/api/messages', { headers: { cookie: user.cookie } });
    expect(listRes.status).toBe(200);
    const list = (await listRes.json()) as Array<{
      id: string;
      role: string;
      text: string;
      createdAt: string;
      proposalId: string | null;
    }>;
    expect(list.map((message) => message.role)).toEqual(['user', 'assistant']);
    expect(list.map((message) => message.text)).toEqual(['Book a plumber Thursday at 10', ASSISTANT_REPLY]);
    expect(list.map((message) => message.proposalId)).toEqual([null, 'prop_from_row']);
    expect(list[1]?.id).toBe(assistant.id);
  });

  it("does not return another user's messages", async () => {
    const { app } = await setupChat();
    const owner = await signUpAndSignIn(app);
    const other = await signUpAndSignIn(app);
    const sendRes = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { cookie: owner.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'only for me' }),
    });
    expect(sendRes.status).toBe(200);

    const listRes = await app.request('/api/messages', { headers: { cookie: other.cookie } });
    expect(listRes.status).toBe(200);
    expect(await listRes.json()).toEqual([]);
  });

  it('returns 503 with the error envelope when the model call fails', async () => {
    const { app } = await setupChat({
      runTurn: () => Promise.reject(new Error('connect ECONNREFUSED 127.0.0.1:11434')),
    });
    const user = await signUpAndSignIn(app);

    const res = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });

    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe('model_unavailable');
    expect(body.error.message).toContain('unavailable');
    expect(body.error.message).not.toContain('ECONNREFUSED');
  });

  it('rejects a missing session, an API key, an empty text, and a forged user_id', async () => {
    const { app } = await setupChat();
    const { user, apiKey } = await createApiKeyUser(app);

    const anon = await app.request('/api/messages');
    expect(anon.status).toBe(401);

    const keyed = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello' }),
    });
    expect(keyed.status).toBe(403);

    const empty = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    });
    expect(empty.status).toBe(400);

    const forged = await app.request('/api/chat/send', {
      method: 'POST',
      headers: { cookie: user.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'hello', user_id: 'victim' }),
    });
    expect(forged.status).toBe(400);
  });
});

describe('GET /api/events', () => {
  it("streams text/event-stream and delivers only this user's event", async () => {
    const { app, bus } = await setupChat();
    const owner = await signUpAndSignIn(app);
    const other = await signUpAndSignIn(app);
    const ownerId = await userIdOf(app, owner.cookie);
    const otherId = await userIdOf(app, other.cookie);

    const res = await app.request('/api/events', { headers: { cookie: owner.cookie } });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');

    bus.publish(otherId, {
      ts: '2026-11-07T00:00:00.000Z',
      type: 'tool_call',
      summary: 'secret for the other user',
    });
    bus.publish(ownerId, {
      ts: '2026-11-07T00:00:01.000Z',
      type: 'model_call',
      summary: 'called the model',
    });

    const body = await collectSse(res, (buf) => buf.includes('called the model'));
    expect(body).toContain('data: ');
    expect(body).toContain('called the model');
    expect(body).not.toContain('secret for the other user');
    const dataLine = body.split('\n').find((line) => line.startsWith('data: '));
    expect(JSON.parse(dataLine?.slice('data: '.length) ?? '{}')).toEqual({
      ts: '2026-11-07T00:00:01.000Z',
      type: 'model_call',
      summary: 'called the model',
    });
  });

  it('requires a user', async () => {
    const { app } = await setupChat();
    const res = await app.request('/api/events');
    expect(res.status).toBe(401);
  });
});

describe('POST /api/dev/provider-cancel/:bookingId', () => {
  it("returns 404 for another user's booking and does not cancel it", async () => {
    const { app, db, cancelBooking, tick } = await setupChat();
    const owner = await signUpAndSignIn(app);
    const other = await signUpAndSignIn(app);
    const ownerId = await userIdOf(app, owner.cookie);
    createBookingsRepo(db).upsert(ownedBooking(ownerId, 'bk_owner'));

    const res = await app.request('/api/dev/provider-cancel/bk_owner', {
      method: 'POST',
      headers: { cookie: other.cookie },
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe('not_found');
    expect(cancelBooking).not.toHaveBeenCalled();
    expect(tick).not.toHaveBeenCalled();
  });

  it("cancels the caller's booking, ticks proactive, and returns ok", async () => {
    const { app, db, cancelBooking, tick } = await setupChat();
    const owner = await signUpAndSignIn(app);
    const ownerId = await userIdOf(app, owner.cookie);
    createBookingsRepo(db).upsert(ownedBooking(ownerId, 'bk_owner'));

    const res = await app.request('/api/dev/provider-cancel/bk_owner', {
      method: 'POST',
      headers: { cookie: owner.cookie },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(cancelBooking).toHaveBeenCalledWith('bk_owner');
    expect(tick).toHaveBeenCalledOnce();
  });

  it('is not registered when dev routes are off', async () => {
    const { app, db, cancelBooking } = await setupChat({ devRoutes: false });
    const owner = await signUpAndSignIn(app);
    const ownerId = await userIdOf(app, owner.cookie);
    createBookingsRepo(db).upsert(ownedBooking(ownerId, 'bk_owner'));

    const res = await app.request('/api/dev/provider-cancel/bk_owner', {
      method: 'POST',
      headers: { cookie: owner.cookie },
    });

    expect(res.status).toBe(404);
    expect(cancelBooking).not.toHaveBeenCalled();
  });
});
