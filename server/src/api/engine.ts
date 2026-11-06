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
 * One core engine per HTTP request, scoped to `api_<requestId>` trace files (plan §13).
 */
export function engineFor(c: Context, deps: EngineForDeps): CoreEngine {
  const requestId = getRequestId(c);
  const trace = createTraceWriter({
    dir: deps.tracesDir,
    runId: `api_${requestId}`,
    clock: deps.clock,
  });
  return createCoreEngine({
    db: deps.db,
    clock: deps.clock,
    providerClient: deps.providerClient,
    trace,
    logger: deps.logger,
    limits: deps.limits,
  });
}
