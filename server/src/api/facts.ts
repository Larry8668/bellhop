import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import type { Hono } from 'hono';
import type { Clock } from '@bellhop/shared/clock';
import { z } from 'zod';
import type { Auth } from '../auth/auth.js';
import { MemoryInputError } from '../memory/errors.js';
import { moduleLogger } from '../memory/logger.js';
import { createMemoryService } from '../memory/service.js';
import type { FactKind, FactStatus, MemoryFact } from '../memory/types.js';
import { parseJsonBody } from './http.js';
import { getRequestId } from './middleware/request-id.js';
import { requireSession } from './middleware/require-session.js';
import { requireUser, type AppVariables } from './middleware/require-user.js';

const UpdateFactBodySchema = z
  .object({
    value: z.string().min(1),
  })
  .strict();

type FactApp = Hono<{ Variables: AppVariables }>;

export interface FactRouteDeps {
  auth: Auth;
  db: Database.Database;
  clock: Clock;
}

interface ApiFact {
  id: string;
  key: string;
  value: string;
  kind: FactKind;
  status: FactStatus;
}

function toApiFact(fact: MemoryFact): ApiFact {
  return { id: fact.id, key: fact.key, value: fact.value, kind: fact.kind, status: fact.status };
}

function notFound(c: Context): Response {
  return c.json({ error: { code: 'not_found', message: 'no such fact' } }, 404);
}

/**
 * Profile fact routes (plan §11, §14). `user_id` is the session principal,
 * never a body or query field. GET accepts a session or API key; mutations
 * require a browser session so a key the model can read cannot edit memory.
 */
export function registerFactRoutes(app: FactApp, deps: FactRouteDeps): void {
  const log = moduleLogger('facts');
  const memory = createMemoryService({ db: deps.db, clock: deps.clock, logger: log });

  app.get('/api/facts', requireUser(deps.auth), (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    try {
      return c.json(memory.list(userId).map(toApiFact));
    } catch (err) {
      log.error({ err, request_id, userId }, 'GET /api/facts failed');
      throw err;
    }
  });

  app.patch('/api/facts/:id', requireSession(deps.auth), async (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    const factId = c.req.param('id');
    const parsed = await parseJsonBody(c, UpdateFactBodySchema);
    if (!parsed.ok) return parsed.response;
    try {
      const updated = memory.update(userId, factId, parsed.body.value);
      if (!updated) {
        log.warn({ request_id, userId, factId }, 'PATCH fact not found');
        return notFound(c);
      }
      return c.json(toApiFact(updated));
    } catch (err) {
      if (err instanceof MemoryInputError) {
        return c.json({ error: { code: 'bad_request', message: err.message } }, 400);
      }
      log.error({ err, request_id, userId, factId }, 'PATCH /api/facts/:id failed');
      throw err;
    }
  });

  app.post('/api/facts/:id/forget', requireSession(deps.auth), (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    const factId = c.req.param('id');
    try {
      const changed = memory.forgetById(userId, factId);
      if (!changed) {
        log.warn({ request_id, userId, factId }, 'POST forget fact not found');
        return notFound(c);
      }
      return c.json({ ok: true as const });
    } catch (err) {
      log.error({ err, request_id, userId, factId }, 'POST /api/facts/:id/forget failed');
      throw err;
    }
  });

  app.post('/api/facts/:id/confirm', requireSession(deps.auth), (c) => {
    const userId = c.get('principal').userId;
    const request_id = getRequestId(c);
    const factId = c.req.param('id');
    try {
      const confirmed = memory.confirm(userId, factId);
      if (!confirmed) {
        log.warn({ request_id, userId, factId }, 'POST confirm fact not found');
        return notFound(c);
      }
      return c.json(toApiFact(confirmed));
    } catch (err) {
      log.error({ err, request_id, userId, factId }, 'POST /api/facts/:id/confirm failed');
      throw err;
    }
  });
}
