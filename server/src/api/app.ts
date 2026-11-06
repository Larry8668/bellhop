import { Hono } from 'hono';
import type { ClientErrorStatusCode } from 'hono/utils/http-status';
import { z, ZodError } from 'zod';
import { APIError } from 'better-auth';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Auth } from '../auth/auth.js';
import type { AppVariables } from './middleware/require-user.js';
import { requireUser } from './middleware/require-user.js';

const createApiKeyBodySchema = z.object({
  name: z.string().min(1),
});

interface CreateApiAppDeps {
  auth: Auth;
  logger: Logger;
}

/**
 * Builds the Hono app: Better Auth's own routes under `/api/auth/*`, plus
 * our minimal API (`/api/me`, `/api/keys`). All error paths funnel through
 * `onError` so every response uses the same `{ error: { code, message } }`
 * envelope (plan §14).
 */
export function createApiApp({ auth, logger }: CreateApiAppDeps): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>();
  const httpLog = childLogger(logger, 'http');

  app.use('*', async (c, next) => {
    const startedAt = performance.now();
    await next();
    const duration_ms = performance.now() - startedAt;
    httpLog.info(
      { method: c.req.method, path: c.req.path, status: c.res.status, duration_ms },
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

  app.onError((err, c) => {
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
