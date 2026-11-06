import { Hono } from 'hono';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Clock } from '@bellhop/shared/clock';
import type { Rng } from '@bellhop/shared/rng';

export function createApp(deps: {
  logger: Logger;
  clock: Clock;
  rng: Rng;
  seed: number;
}): Hono {
  const { logger, clock, rng: _rng, seed } = deps;
  void _rng;

  const app = new Hono();
  const httpLog = childLogger(logger, 'http');

  app.use('*', async (c, next) => {
    const startMs = clock.nowMs();
    await next();
    const duration_ms = clock.nowMs() - startMs;
    httpLog.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        duration_ms,
      },
      'request',
    );
  });

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      now: clock.now().toISOString(),
      seed,
    });
  });

  app.onError((err, c) => {
    const stack = err instanceof Error ? err.stack : undefined;
    logger.error({ err, stack }, 'request failed');
    return c.json(
      { error: { code: 'internal', message: 'internal error' } },
      500,
    );
  });

  app.notFound((c) => {
    return c.json(
      { error: { code: 'not_found', message: 'no such route' } },
      404,
    );
  });

  return app;
}
