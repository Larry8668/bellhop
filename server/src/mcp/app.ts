import { Hono } from 'hono';
import type { Context } from 'hono';
import { StreamableHTTPTransport } from '@hono/mcp';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { Auth } from '../auth/auth.js';
import { resolvePrincipal } from '../auth/principal.js';
import type { ProviderClient } from '../provider-client/index.js';
import { getRequestId, requestIdMiddleware, type RequestIdEnv } from '../api/middleware/request-id.js';
import { createMcpServer } from './server.js';

export interface CreateMcpAppDeps {
  auth: Auth;
  providerClient: ProviderClient;
  logger: Logger;
}

/**
 * Mounts the stateless MCP endpoint (plan §15). One `McpServer` + transport
 * per request, bound to the principal resolved from the request itself
 * (session cookie or API key — coding-standards.mdc invariant 2), so no
 * server-side session state outlives the request.
 */
export function createMcpApp({ auth, providerClient, logger }: CreateMcpAppDeps): Hono<RequestIdEnv> {
  const app = new Hono<RequestIdEnv>();
  const mcpLog = childLogger(logger, 'mcp');

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

  app.all('/mcp', async (c) => {
    const startedAt = performance.now();
    const principal = await resolvePrincipal(auth, c.req.raw.headers);
    if (!principal) {
      const res = c.json({ error: { code: 'unauthorized', message: 'authentication required' } }, 401);
      logRequest(c, c.req.method, res, startedAt);
      return res;
    }

    // Stateless server: there is no session for a client to terminate.
    if (c.req.method === 'DELETE') {
      const res = c.json(
        { error: { code: 'method_not_allowed', message: 'stateless server: no session to terminate' } },
        405,
      );
      logRequest(c, c.req.method, res, startedAt, principal.via);
      return res;
    }

    // The standalone GET/SSE stream is for server-initiated notifications on
    // a live session; stateless mode has no session to hold one open for.
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

    // No `sessionIdGenerator` → stateless mode: no session is created or
    // tracked, consistent with "Stateless mode (no session ids)" (task §MCP).
    const requestId = getRequestId(c);
    const mcpServer = createMcpServer({ providerClient, principal, logger, requestId });
    const transport = new StreamableHTTPTransport();
    await mcpServer.connect(transport);

    const response = await transport.handleRequest(c);
    const res = response ?? c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
    logRequest(c, c.req.method, res, startedAt, principal.via);
    return res;
  });

  return app;
}
