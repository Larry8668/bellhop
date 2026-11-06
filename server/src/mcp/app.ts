import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { Context } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { Auth } from '../auth/auth.js';
import { resolvePrincipal, type Principal } from '../auth/principal.js';
import type { ProviderClient } from '../provider-client/index.js';
import { createCoreEngine } from '../core/engine.js';
import type { ExecutionLimits } from '../core/actions/executor.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { createTraceWriter } from '../trace/writer.js';
import { getRequestId, requestIdMiddleware, type RequestIdEnv } from '../api/middleware/request-id.js';
import { createMcpServer } from './server.js';

export interface CreateMcpAppDeps {
  auth: Auth;
  providerClient: ProviderClient;
  logger: Logger;
  db: Database.Database;
  clock: Clock;
  limits: ExecutionLimits;
  tracesDir: string;
  /** Shared across every route that touches a user's workflow, so an MCP `propose_*` call never interleaves with an API turn or event (plan §8). */
  queue: UserQueue;
  webOrigin: string;
}

interface McpSession {
  server: ReturnType<typeof createMcpServer>;
  transport: StreamableHTTPTransport;
  lastActiveMs: number;
  /** The principal `initialize` was resolved for; every later request on this session id must match (invariant 2 — never trust the caller, only what auth resolved). */
  userId: string;
}

/** Bounds the in-memory session map so a client that never disconnects can't grow it without limit. */
const MAX_SESSIONS = 1000;
/** Idle sessions older than this are swept (plan §15 has no explicit value; generous enough for a chat turn plus its elicitation round trip). */
const SESSION_IDLE_MS = 30 * 60 * 1000;
const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * Mounts the MCP endpoint (plan §15).
 *
 * `/mcp` keeps "stateless" in the sense the plan means it: no server-side
 * business state outlives a request — `user_id` only ever comes from
 * re-resolving the principal on every call, and the core engine is the one
 * source of truth (coding-standards.mdc invariant 3), never anything held
 * in this map.
 *
 * It cannot, however, use a brand-new `McpServer`/transport per literal
 * HTTP request: MCP elicitation (plan §7, §15) is a server-initiated
 * request that the client answers with a *separate* follow-up HTTP POST,
 * and only the exact `Server`/transport instance that asked can resolve
 * that pending request — a fresh one per request has no memory of asking
 * and the answer is silently dropped. So one `McpServer` + transport is
 * created at `initialize` and reused for the rest of that connection's
 * requests (correlated by the SDK's own `Mcp-Session-Id`, which the
 * client already resends automatically) exactly as the MCP SDK's own
 * elicitation examples do — this is transport-level session bookkeeping
 * only, not a second source of truth for anything the plan's tables own.
 */
export function createMcpApp({
  auth,
  providerClient,
  logger,
  db,
  clock,
  limits,
  tracesDir,
  queue,
  webOrigin,
}: CreateMcpAppDeps): Hono<RequestIdEnv> {
  const app = new Hono<RequestIdEnv>();
  const mcpLog = childLogger(logger, 'mcp');
  const sessions = new Map<string, McpSession>();

  // No `onsessionclosed` hook: DELETE is unconditionally rejected below (the
  // route never offers client-initiated termination), so idle sweep is the
  // only way a session's resources are freed.
  const sweep = setInterval(() => {
    const cutoff = clock.nowMs() - SESSION_IDLE_MS;
    for (const [sessionId, session] of sessions) {
      if (session.lastActiveMs < cutoff) {
        sessions.delete(sessionId);
        session.transport.close().catch((err: unknown) => mcpLog.warn({ err, sessionId }, 'session sweep: close failed'));
      }
    }
  }, SESSION_SWEEP_INTERVAL_MS);
  sweep.unref();

  app.use('*', requestIdMiddleware());

  function logRequest(
    c: Context<RequestIdEnv>,
    method: string,
    response: Response,
    startedAt: number,
    via?: string,
  ) {
    const request_id = getRequestId(c);
    mcpLog.info(
      {
        method,
        status: response.status,
        duration_ms: Math.round(performance.now() - startedAt),
        via,
        request_id,
      },
      'request',
    );
  }

  /**
   * Builds the `McpServer` + transport for a brand-new session, connects
   * them, and registers the session once the SDK assigns it an id.
   * `requestId` (the propagated `x-request-id`) is only ever logged below —
   * the trace file name is always a server-minted id, never a client-
   * controlled header value.
   */
  async function startSession(principal: Principal, requestId: string): Promise<McpSession> {
    const runId = `mcp_${randomUUID()}`;
    mcpLog.debug({ requestId, runId, userId: principal.userId }, 'mcp session started');
    const trace = createTraceWriter({ dir: tracesDir, runId, clock });
    const engine = createCoreEngine({ db, clock, providerClient, trace, logger, limits, requestId });
    const server = createMcpServer({ providerClient, principal, logger, requestId, engine, queue, webOrigin });
    // The callback runs during a later handleRequest, after `session` exists.
    const transport = new StreamableHTTPTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId: string) => {
        sessions.set(sessionId, session);
      },
    });
    const session: McpSession = { server, transport, lastActiveMs: clock.nowMs(), userId: principal.userId };
    await server.connect(transport);
    return session;
  }

  app.all('/mcp', async (c) => {
    const startedAt = performance.now();
    const principal = await resolvePrincipal(auth, c.req.raw.headers);
    if (!principal) {
      const res = c.json({ error: { code: 'unauthorized', message: 'authentication required' } }, 401);
      logRequest(c, c.req.method, res, startedAt);
      return res;
    }

    // No client-initiated termination: sessions only end via the idle sweep above.
    if (c.req.method === 'DELETE') {
      const res = c.json(
        { error: { code: 'method_not_allowed', message: 'session termination is not supported' } },
        405,
      );
      logRequest(c, c.req.method, res, startedAt, principal.via);
      return res;
    }

    // The standalone GET/SSE stream is for server-initiated notifications on
    // a live session; without one there is nothing to hold open.
    if (c.req.method === 'GET') {
      const accept = c.req.header('accept') ?? '';
      if (!accept.includes('text/event-stream')) {
        const res = c.json(
          {
            error: {
              code: 'method_not_allowed',
              message: 'GET requires an Accept: text/event-stream client',
            },
          },
          405,
        );
        logRequest(c, c.req.method, res, startedAt, principal.via);
        return res;
      }
    }

    const requestId = getRequestId(c);
    const incomingSessionId = c.req.header('mcp-session-id');
    let session = incomingSessionId !== undefined ? sessions.get(incomingSessionId) : undefined;

    // A session id is only a transport correlation handle, never proof of
    // identity (invariant 2): a request carrying someone else's session id
    // but a different caller's own valid credentials must not reuse that
    // session's engine/tools, which were built bound to the original user.
    if (session !== undefined && session.userId !== principal.userId) {
      mcpLog.warn({ sessionId: incomingSessionId, userId: principal.userId }, 'mcp-session-id does not belong to this principal');
      const res = c.json({ error: { code: 'unauthorized', message: 'session does not belong to this principal' } }, 401);
      logRequest(c, c.req.method, res, startedAt, principal.via);
      return res;
    }

    // Unknown id (restart, sweep): MCP spec says 404 so the client re-initialises
    // instead of this route silently starting an unregistered server for it.
    if (session === undefined && incomingSessionId !== undefined) {
      const res = c.json({ error: { code: 'not_found', message: 'unknown MCP session; re-initialize' } }, 404);
      logRequest(c, c.req.method, res, startedAt, principal.via);
      return res;
    }

    if (session === undefined) {
      if (sessions.size >= MAX_SESSIONS) {
        const res = c.json({ error: { code: 'internal', message: 'too many open MCP sessions' } }, 503);
        logRequest(c, c.req.method, res, startedAt, principal.via);
        return res;
      }
      session = await startSession(principal, requestId);
    } else {
      session.lastActiveMs = clock.nowMs();
    }

    const response = await session.transport.handleRequest(c);
    const res = response ?? c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
    logRequest(c, c.req.method, res, startedAt, principal.via);
    return res;
  });

  return app;
}
