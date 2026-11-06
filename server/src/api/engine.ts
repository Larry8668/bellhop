import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import type { Context } from 'hono';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { createCoreEngine, type CoreEngine } from '../core/engine.js';
import type { ExecutionLimits } from '../core/actions/executor.js';
import type { ProviderClient } from '../provider-client/client.js';
import { createTraceWriter } from '../trace/writer.js';
import { getRequestId } from './middleware/request-id.js';

export interface EngineForDeps {
  db: Database.Database;
  clock: Clock;
  limits: ExecutionLimits;
  tracesDir: string;
  providerClient: ProviderClient;
  logger: Logger;
}

/**
 * One core engine per HTTP request, scoped to a server-minted `api_<uuid>`
 * trace file (plan §13). The trace file name must never be derived from a
 * client-controlled header: `x-request-id` is only ever logged for
 * correlation, never used to pick a path on disk.
 */
export function engineFor(c: Context, deps: EngineForDeps): CoreEngine {
  const requestId = getRequestId(c);
  const runId = `api_${randomUUID()}`;
  deps.logger.debug({ requestId, runId }, 'engine created for request');
  const trace = createTraceWriter({
    dir: deps.tracesDir,
    runId,
    clock: deps.clock,
  });
  return createCoreEngine({
    db: deps.db,
    clock: deps.clock,
    providerClient: deps.providerClient,
    trace,
    logger: deps.logger,
    limits: deps.limits,
    requestId,
  });
}
