import { Hono } from 'hono';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Rng } from '@bellhop/shared/rng';
import type { AdjustableClock } from './clock.js';
import type { ProviderEngine } from './engine/engine.js';
import { createAdminRoutes } from './http/admin.js';
import { getRequestId, requestIdMiddleware, type RequestIdEnv } from './http/request-id.js';
import { createToolRoutes } from './http/tools.js';
import type { ScenarioQueue } from './scenarios.js';
import type { TimeoutControl } from './timeouts.js';

export function createApp(deps: {
  logger: Logger;
  clock: AdjustableClock;
  rng: Rng;
  seed: number;
  engine: ProviderEngine;
  scenarios: ScenarioQueue;
  timeouts: TimeoutControl;
  adminEnabled: boolean;
}): Hono<RequestIdEnv> {
  const { logger, clock, rng: _rng, seed, engine, scenarios, timeouts, adminEnabled } = deps;
  void _rng;

  const app = new Hono<RequestIdEnv>();
  const httpLog = childLogger(logger, 'http');

  app.use('*', requestIdMiddleware());

  app.use('*', async (c, next) => {
    const startMs = clock.nowMs();
    await next();
    const duration_ms = clock.nowMs() - startMs;
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

  app.get('/health', (c) => {
    return c.json({
      ok: true,
      now: clock.now().toISOString(),
      seed,
      pending_scenarios: scenarios.pending().length,
    });
  });

  app.route('/', createToolRoutes({ engine, clock, logger, timeouts }));

  // Unmounted when disabled: any `/__admin/*` request simply falls through
  // to `notFound` below, which is the 404 envelope the plan requires.
  if (adminEnabled) {
    app.route('/', createAdminRoutes({ engine, clock, scenarios, timeouts, logger }));
  }

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
