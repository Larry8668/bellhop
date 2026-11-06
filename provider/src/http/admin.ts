import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  ADMIN_PATHS,
  AdminClockRequestSchema,
  AdminResetRequestSchema,
  AdminScenarioRequestSchema,
  AdminStateResponseSchema,
} from '@bellhop/shared/contracts';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { AdjustableClock } from '../clock.js';
import type { ProviderEngine } from '../engine/engine.js';
import { ToolError, toErrorBody } from '../engine/errors.js';
import type { ScenarioQueue } from '../scenarios.js';
import type { TimeoutControl } from '../timeouts.js';

/** Admin bodies are often empty (e.g. `reset` with no seed); treat unparsable JSON as `{}` rather than 400. */
async function readJsonBody(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return {};
  }
}

function badRequest(c: Context, issues: unknown) {
  return c.json(
    { error: { code: 'bad_request', message: 'admin request body failed validation', details: issues } },
    400,
  );
}

export function createAdminRoutes(deps: {
  engine: ProviderEngine;
  clock: AdjustableClock;
  scenarios: ScenarioQueue;
  timeouts: TimeoutControl;
  logger: Logger;
}): Hono {
  const { engine, clock, scenarios, timeouts, logger } = deps;
  const log = childLogger(logger, 'http.admin');
  const app = new Hono();

  app.post(ADMIN_PATHS.reset, async (c) => {
    const parsed = AdminResetRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return badRequest(c, parsed.error.issues);

    engine.admin.reset(parsed.data.seed);
    const seed = engine.admin.seed();
    log.info({ seed }, 'admin reset');
    return c.json({ ok: true, seed });
  });

  app.post(ADMIN_PATHS.scenario, async (c) => {
    const parsed = AdminScenarioRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return badRequest(c, parsed.error.issues);

    scenarios.push(parsed.data.outcomes);
    if (parsed.data.timeout_delay_ms !== undefined) {
      timeouts.setDelayMs(parsed.data.timeout_delay_ms);
    }
    log.info({ outcomes: parsed.data.outcomes }, 'admin scenario pushed');
    return c.json({ ok: true, pending_scenarios: scenarios.pending() });
  });

  app.post(ADMIN_PATHS.clock, async (c) => {
    const parsed = AdminClockRequestSchema.safeParse(await readJsonBody(c));
    if (!parsed.success) return badRequest(c, parsed.error.issues);

    if (parsed.data.set !== undefined) {
      clock.set(Date.parse(parsed.data.set));
    } else if (parsed.data.advance_ms !== undefined) {
      clock.advance(parsed.data.advance_ms);
    }
    const now = clock.now().toISOString();
    log.info({ now }, 'admin clock updated');
    return c.json({ now });
  });

  // Literal path (not `ADMIN_PATHS.cancelBooking(':id')`) so Hono can type `c.req.param('id')` as `string`.
  app.post('/__admin/cancel-booking/:id', (c) => {
    const id = c.req.param('id');
    try {
      const booking = engine.admin.cancelBookingByProvider(id);
      log.info({ bookingId: id }, 'admin cancelled booking');
      return c.json({ booking });
    } catch (err) {
      if (err instanceof ToolError) {
        return c.json(toErrorBody(err), 404);
      }
      throw err;
    }
  });

  app.get(ADMIN_PATHS.state, (c) => {
    const state = AdminStateResponseSchema.parse({
      ...engine.admin.state(),
      timeout_delay_ms: timeouts.getDelayMs(),
    });
    return c.json(state);
  });

  return app;
}
