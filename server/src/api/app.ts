import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { ClientErrorStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';
import { APIError } from 'better-auth';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Auth } from '../auth/auth.js';
import type { ProviderClient } from '../provider-client/client.js';
import { ProviderError } from '../provider-client/errors.js';
import { describeOutcome } from '../core/actions/outcomes.js';
import { createApprovalsRepo } from '../core/repo/approvals.repo.js';
import type { ExecutionLimits } from '../core/actions/executor.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import type { AppVariables } from './middleware/require-user.js';
import { requireUser } from './middleware/require-user.js';
import { requireSession } from './middleware/require-session.js';
import { getRequestId, requestIdMiddleware } from './middleware/request-id.js';
import { parseJsonBody } from './http.js';
import { sortWebBookings } from './bookings.js';
import { engineFor } from './engine.js';
import { providerErrorStatus } from './provider-error.js';
import {
  ApproveProposalBodySchema,
  PostProposalBodySchema,
} from './schemas/proposals.js';

const createApiKeyBodySchema = z.object({
  name: z.string().min(1),
});

export interface CreateApiAppDeps {
  auth: Auth;
  logger: Logger;
  providerClient: ProviderClient;
  webOrigin: string;
  db: Database.Database;
  clock: Clock;
  limits: ExecutionLimits;
  tracesDir: string;
  queue: UserQueue;
}

/**
 * Builds the Hono app: Better Auth's own routes under `/api/auth/*`, plus
 * our minimal API (`/api/me`, `/api/keys`, `/api/bookings`). All error paths
 * funnel through `onError` so every response uses the same
 * `{ error: { code, message } }` envelope (plan §14).
 */
export function createApiApp({
  auth,
  logger,
  providerClient,
  webOrigin,
  db,
  clock,
  limits,
  tracesDir,
  queue,
}: CreateApiAppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const httpLog = childLogger(logger, 'http');
  const engineDeps = { db, clock, limits, tracesDir, providerClient, logger };

  app.use(
    '/api/*',
    cors({
      origin: webOrigin,
      credentials: true,
      allowHeaders: ['content-type', 'authorization', 'x-api-key', 'x-request-id'],
    }),
  );

  app.use('*', requestIdMiddleware());

  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    const duration_ms = performance.now() - startedAt;
    const request_id = getRequestId(c);
    httpLog.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms,
        request_id,
      },
      'request',
    );
  });

  app.get('/api/health', (c) => c.json({ ok: true }));

  // Better Auth owns sign-up/sign-in/sign-out/session/api-key-crud routes.
  app.on(['GET', 'POST'], '/api/auth/*', (c) => auth.handler(c.req.raw));

  app.get('/api/me', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    const context = await auth.$context;
    const user = await context.internalAdapter.findUserById(principal.userId);
    if (!user) {
      // The session/API key was valid but its owning user is gone — a data
      // invariant break, not a client error.
      throw new Error(`principal ${principal.userId} has no backing user record`);
    }
    return c.json({ user: { id: user.id, email: user.email, name: user.name }, via: principal.via });
  });

  app.post('/api/keys', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    if (principal.via !== 'session') {
      return c.json({ error: { code: 'forbidden', message: 'API keys can only be created from a browser session' } }, 403);
    }

    const body = createApiKeyBodySchema.parse(await c.req.json());
    const created = await auth.api.createApiKey({
      headers: c.req.raw.headers,
      body: { name: body.name },
    });

    return c.json({ id: created.id, name: created.name, key: created.key, createdAt: created.createdAt }, 201);
  });

  app.get('/api/keys', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    if (principal.via !== 'session') {
      return c.json({ error: { code: 'forbidden', message: 'API keys can only be managed from a browser session' } }, 403);
    }

    const result = await auth.api.listApiKeys({ headers: c.req.raw.headers });
    return c.json({
      keys: result.apiKeys.map((apiKey) => ({
        id: apiKey.id,
        name: apiKey.name,
        start: apiKey.start ?? undefined,
        prefix: apiKey.prefix ?? undefined,
        createdAt: apiKey.createdAt,
        enabled: apiKey.enabled,
      })),
    });
  });

  app.delete('/api/keys/:id', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    if (principal.via !== 'session') {
      return c.json({ error: { code: 'forbidden', message: 'API keys can only be managed from a browser session' } }, 403);
    }

    await auth.api.deleteApiKey({
      headers: c.req.raw.headers,
      body: { keyId: c.req.param('id') },
    });
    return c.json({ success: true });
  });

  // `user_id` always comes from the resolved principal, never a body/query
  // param (coding-standards.mdc invariant 2) — the route reads nothing else.
  app.get('/api/bookings', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    const result = await providerClient.list_bookings(
      principal.userId,
      {
        user_id: principal.userId,
      },
      { requestId: getRequestId(c) },
    );
    return c.json(sortWebBookings(result.bookings));
  });

  app.get('/api/task', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    const request_id = getRequestId(c);
    const userId = principal.userId;
    try {
      const engine = engineFor(c, engineDeps);
      const task = engine.taskState.get(userId);
      return c.json({ task: task ?? null });
    } catch (err) {
      httpLog.error({ err, request_id, userId }, 'GET /api/task failed');
      throw err;
    }
  });

  app.get('/api/proposals', requireUser(auth), async (c) => {
    const principal = c.get('principal');
    const request_id = getRequestId(c);
    const userId = principal.userId;
    try {
      const engine = engineFor(c, engineDeps);
      const proposals = engine.proposals.listPending(userId);
      return c.json({ proposals });
    } catch (err) {
      httpLog.error({ err, request_id, userId }, 'GET /api/proposals failed');
      throw err;
    }
  });

  app.post('/api/proposals', requireSession(auth), async (c) => {
    const principal = c.get('principal');
    const request_id = getRequestId(c);
    const userId = principal.userId;
    const parsed = await parseJsonBody(c, PostProposalBodySchema);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body;
    try {
      return await queue.run(userId, 'api:propose', async () => {
        const engine = engineFor(c, engineDeps);
        if (body.action === 'book') {
          const result = await engine.proposals.proposeBooking(userId, {
            provider_id: body.provider_id,
            // The core service still requires a non-empty provider_name
            // (gate fix item 5 drops it from this wire schema, but core
            // isn't allowed to change in this worktree); the real name is
            // display-only on the card and the core delegate's change makes
            // this field optional-and-ignored, so a placeholder is harmless.
            provider_name: body.service,
            service: body.service,
            slot: body.slot,
          });
          if (!result.ok) {
            return c.json({ error: { code: result.code, message: result.message } }, 409);
          }
          return c.json({ proposal: result.proposal });
        }
        if (body.action === 'cancel') {
          const result = await engine.proposals.proposeCancel(userId, { booking_id: body.booking_id });
          if (!result.ok) {
            return c.json({ error: { code: result.code, message: result.message } }, 409);
          }
          return c.json({ proposal: result.proposal });
        }
        const result = await engine.proposals.proposeReschedule(userId, {
          booking_id: body.booking_id,
          slot: body.slot,
        });
        if (!result.ok) {
          return c.json({ error: { code: result.code, message: result.message } }, 409);
        }
        return c.json({ proposal: result.proposal });
      });
    } catch (err) {
      httpLog.error({ err, request_id, userId }, 'POST /api/proposals failed');
      throw err;
    }
  });

  app.post('/api/proposals/:id/approve', requireSession(auth), async (c) => {
    const principal = c.get('principal');
    const request_id = getRequestId(c);
    const userId = principal.userId;
    const proposal_id = c.req.param('id');

    const parsed = await parseJsonBody(c, ApproveProposalBodySchema);
    if (!parsed.ok) return parsed.response;
    const parsedBody = parsed.body;

    try {
      return await queue.run(userId, 'api:approve', async () => {
        const engine = engineFor(c, engineDeps);
        const approved = engine.approvals.approve(userId, {
          proposal_id,
          hash: parsedBody.hash,
          source: 'button',
        });
        let approvalId: string | undefined;
        if (approved.ok) {
          approvalId = approved.approval.id;
        } else if (approved.reason === 'proposal_not_pending') {
          // Repeated Confirm (plan §8): re-run the executor with the approval the
          // user already created — it replays a finished action — but only when
          // the submitted hash is the one that approval was made with.
          const latest = createApprovalsRepo(db).getLatestForProposal(userId, proposal_id);
          if (latest === undefined || latest.hash !== parsedBody.hash) {
            httpLog.warn({ request_id, userId, proposal_id }, 'POST approve: proposal not pending');
            return c.json(
              { error: { code: 'proposal_not_pending', message: 'proposal is not pending' } },
              409,
            );
          }
          approvalId = latest.id;
        } else {
          const code =
            approved.reason === 'hash_mismatch'
              ? 'hash_mismatch'
              : approved.reason === 'proposal_not_found'
                ? 'proposal_not_found'
                : approved.reason;
          const message =
            approved.reason === 'hash_mismatch'
              ? 'confirmation hash does not match the proposal'
              : approved.reason === 'proposal_not_found'
                ? 'no such proposal'
                : 'cannot approve in the current task state';
          if (approved.reason === 'proposal_not_found') {
            httpLog.warn({ request_id, userId, proposal_id }, 'POST approve: proposal not found');
            return c.json({ error: { code, message } }, 404);
          }
          httpLog.warn({ request_id, userId, proposal_id, reason: approved.reason }, 'POST approve rejected');
          return c.json({ error: { code, message } }, 409);
        }

        const outcome = await engine.executor.execute(userId, approvalId);
        return c.json({
          outcome,
          message: describeOutcome(outcome),
        });
      });
    } catch (err) {
      httpLog.error({ err, request_id, userId, proposal_id }, 'POST /api/proposals/:id/approve failed');
      throw err;
    }
  });

  app.post('/api/proposals/:id/decline', requireSession(auth), async (c) => {
    const principal = c.get('principal');
    const request_id = getRequestId(c);
    const userId = principal.userId;
    const proposal_id = c.req.param('id');
    try {
      return await queue.run(userId, 'api:decline', async () => {
        const engine = engineFor(c, engineDeps);
        const result = engine.proposals.decline(userId, proposal_id);
        if (!result.ok && result.code === 'proposal_not_found') {
          httpLog.warn({ request_id, userId, proposal_id }, 'POST decline: proposal not found');
          return c.json({ error: { code: 'proposal_not_found', message: 'no such proposal' } }, 404);
        }
        if (!result.ok) {
          httpLog.warn(
            { request_id, userId, proposal_id, code: result.code },
            'POST decline rejected',
          );
          return c.json({ error: { code: result.code, message: result.message } }, 409);
        }
        return c.json({ ok: true as const });
      });
    } catch (err) {
      httpLog.error({ err, request_id, userId, proposal_id }, 'POST /api/proposals/:id/decline failed');
      throw err;
    }
  });

  app.onError((err, c) => {
    if (err instanceof ProviderError) {
      const status = providerErrorStatus(err.code);
      if (status >= 500) {
        logger.error({ err, tool: err.tool, code: err.code }, 'provider call failed');
      } else {
        logger.warn({ tool: err.tool, code: err.code }, 'provider call rejected');
      }
      return c.json({ error: { code: err.code, message: err.message, details: err.details } }, status);
    }
    if (err instanceof ZodError) {
      return c.json(
        { error: { code: 'bad_request', message: 'invalid request body', details: err.issues } },
        400,
      );
    }
    if (err instanceof SyntaxError) {
      return c.json({ error: { code: 'bad_request', message: 'invalid JSON body' } }, 400);
    }
    if (err instanceof APIError) {
      const status = err.statusCode;
      const code = typeof err.body?.code === 'string' ? err.body.code.toLowerCase() : 'bad_request';
      const message = err.body?.message ?? err.message;
      if (status >= 500) {
        logger.error({ err, stack: err.stack }, 'auth request failed');
        return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
      }
      return c.json({ error: { code, message } }, status as ClientErrorStatusCode);
    }

    logger.error({ err, stack: err instanceof Error ? err.stack : undefined }, 'request failed');
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });

  app.notFound((c) => c.json({ error: { code: 'not_found', message: 'no such route' } }, 404));

  return app;
}
