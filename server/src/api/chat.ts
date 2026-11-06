import type Database from 'better-sqlite3';
import type { Context, Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import { z } from 'zod';
import type { Clock } from '@bellhop/shared/clock';
import type { LanguageModel } from 'ai';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { Auth } from '../auth/auth.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { createBookingsRepo } from '../core/repo/bookings.repo.js';
import { createMessagesRepo } from '../core/repo/messages.repo.js';
import type { Message } from '../core/types.js';
import type { EventBus } from '../events/bus.js';
import type { ProviderClient } from '../provider-client/client.js';
import type { HarnessMemory, Proactive, RunTurn, TurnEvent, TurnLimits } from '../wiring/deps.js';
import { getRequestId } from './middleware/request-id.js';
import { requireSession } from './middleware/require-session.js';
import { requireUser, type AppVariables } from './middleware/require-user.js';
import { parseJsonBody } from './http.js';

/** Comment frame so a proxy does not close a quiet trace stream (plan §14). */
const SSE_HEARTBEAT_MS = 15_000;

const sendBodySchema = z
  .object({
    text: z.string().min(1).max(2000),
  })
  .strict();

const bookingIdSchema = z.string().min(1).max(128);

/** Wire shape for `GET /api/messages` and `POST /api/chat/send`. `proposalId` is `messages.proposal_id`. */
export const chatMessageWireSchema = z.object({
  id: z.string(),
  role: z.enum(['user', 'assistant', 'system']),
  text: z.string(),
  createdAt: z.string(),
  proposalId: z.string().nullable(),
});

const busEventSchema = z.object({
  ts: z.string(),
  type: z.string(),
  summary: z.string(),
  detail: z.unknown().optional(),
});

export interface ProviderAdmin {
  cancelBooking(bookingId: string): Promise<void>;
}

export interface ChatRouteDeps {
  auth: Auth;
  logger: Logger;
  providerClient: ProviderClient;
  db: Database.Database;
  clock: Clock;
  tracesDir: string;
  queue: UserQueue;
  model: LanguageModel;
  memory: HarnessMemory;
  bus: EventBus;
  turnLimits: TurnLimits;
  runTurn: RunTurn;
  proactive: Proactive;
  devRoutes: boolean;
  providerAdmin: ProviderAdmin;
}

function toChatMessage(message: Message): z.infer<typeof chatMessageWireSchema> {
  return chatMessageWireSchema.parse({
    id: message.id,
    role: message.role,
    text: message.text,
    createdAt: message.created_at,
    proposalId: message.proposal_id,
  });
}

function unavailable(c: Context, message: string): Response {
  return c.json({ error: { code: 'model_unavailable', message } }, 503);
}

/**
 * Chat, trace-stream, and the dev provider-cancel button (plan §12, §14).
 * `runTurn` persists both messages itself; this layer only reads the latest
 * assistant row back so the HTTP response matches what was stored.
 */
export function registerChatRoutes(app: Hono<{ Variables: AppVariables }>, deps: ChatRouteDeps): void {
  const {
    auth,
    logger,
    providerClient,
    db,
    clock,
    tracesDir,
    queue,
    model,
    memory,
    bus,
    turnLimits,
    runTurn,
    proactive,
    devRoutes,
    providerAdmin,
  } = deps;
  const log = childLogger(logger, 'chat');

  app.get('/api/messages', requireUser(auth), (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    try {
      const messages = createMessagesRepo(db).listAll(userId).map(toChatMessage);
      return c.json(messages);
    } catch (err) {
      log.error({ err, request_id, userId }, 'GET /api/messages failed');
      throw err;
    }
  });

  app.post('/api/chat/send', requireSession(auth), async (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    const parsed = await parseJsonBody(c, sendBodySchema);
    if (!parsed.ok) return parsed.response;
    const { text } = parsed.body;

    try {
      return await queue.run(userId, 'chat', async () => {
        let result;
        try {
          result = await runTurn(
            {
              db,
              clock,
              model,
              providerClient,
              logger,
              tracesDir,
              limits: turnLimits,
              memory,
              onEvent: (event: TurnEvent) => {
                const checked = busEventSchema.safeParse(event);
                if (!checked.success) {
                  log.warn({ request_id, userId }, 'dropping invalid turn event');
                  return;
                }
                bus.publish(userId, {
                  ts: checked.data.ts,
                  type: checked.data.type,
                  summary: checked.data.summary,
                  ...(checked.data.detail !== undefined ? { detail: checked.data.detail } : {}),
                });
              },
            },
            { userId, text },
          );
        } catch (err) {
          log.error({ err, request_id, userId }, 'chat turn failed');
          return unavailable(c, 'The assistant is unavailable right now. Try again shortly.');
        }

        const latest = createMessagesRepo(db).listRecent(userId, 1).at(-1);
        if (latest === undefined || latest.role !== 'assistant') {
          log.error({ request_id, userId, runId: result.runId, exit: result.exit }, 'chat turn finished without an assistant message');
          return unavailable(c, 'The assistant did not produce a reply. Try again.');
        }

        log.info({ request_id, userId, runId: result.runId, exit: result.exit }, 'chat turn finished');
        return c.json(toChatMessage(latest));
      });
    } catch (err) {
      log.error({ err, request_id, userId }, 'POST /api/chat/send failed');
      throw err;
    }
  });

  app.get('/api/events', requireUser(auth), (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    log.debug({ request_id, userId }, 'sse subscribe');

    return streamSSE(c, async (stream) => {
      const heartbeat = setInterval(() => {
        void stream.write(': heartbeat\n\n');
      }, SSE_HEARTBEAT_MS);
      heartbeat.unref();

      let unsubscribe = (): void => {};
      const closed = new Promise<void>((resolve) => {
        if (stream.aborted) resolve();
        else stream.onAbort(() => resolve());
      });

      try {
        unsubscribe = bus.subscribe(userId, (event) => {
          void stream.writeSSE({ data: JSON.stringify(event) });
        });
        await closed;
      } finally {
        clearInterval(heartbeat);
        unsubscribe();
        log.debug({ request_id, userId }, 'sse unsubscribe');
      }
    });
  });

  if (!devRoutes) return;

  // Plan §12: a dev button that cancels at the provider, then lets proactive look for a replacement.
  app.post('/api/dev/provider-cancel/:bookingId', requireSession(auth), async (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    const bookingIdParsed = bookingIdSchema.safeParse(c.req.param('bookingId'));
    if (!bookingIdParsed.success) {
      return c.json({ error: { code: 'bad_request', message: 'invalid booking id' } }, 400);
    }
    const bookingId = bookingIdParsed.data;
    const booking = createBookingsRepo(db).get(userId, bookingId);
    if (booking === undefined) {
      log.warn({ request_id, userId, bookingId }, 'dev provider-cancel: booking not found');
      return c.json({ error: { code: 'not_found', message: 'no such booking' } }, 404);
    }

    try {
      await providerAdmin.cancelBooking(bookingId);
    } catch (err) {
      log.error({ err, request_id, userId, bookingId }, 'dev provider-cancel failed');
      return c.json(
        { error: { code: 'provider_unavailable', message: 'Could not cancel that booking at the provider. Try again.' } },
        503,
      );
    }

    try {
      await proactive.tick();
    } catch (err) {
      log.error({ err, request_id, userId, bookingId }, 'proactive tick after dev cancel failed');
      return c.json(
        {
          error: {
            code: 'proactive_unavailable',
            message: 'The booking was cancelled, but the follow-up check did not finish. Try again.',
          },
        },
        503,
      );
    }

    log.info({ request_id, userId, bookingId }, 'dev provider-cancel');
    return c.json({ ok: true as const });
  });
}
