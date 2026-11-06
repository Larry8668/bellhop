import type Database from 'better-sqlite3';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import { startTestProvider, type StartTestProviderOptions, type TestProvider } from '@bellhop/provider/testing';
import { createProviderClient, type ProviderClient } from '../../src/provider-client/index.js';
import { createTestDb, TEST_USER } from '../core/helpers.js';
import { createFakeTraceWriter, type FakeTraceWriter } from './fake-trace.js';

export interface CoreHarnessOptions {
  seed?: number;
  clockStartMs?: number;
  /** Reserved for wave 3 executors (bounded status-check polling); accepted here, not consumed. */
  statusChecks?: number;
  /** Reserved for wave 3 executors (bounded provider-call retries); accepted here, not consumed. */
  retriesPerTool?: number;
}

export interface CoreHarness {
  db: Database.Database;
  /** Same clock instance the provider advances internally (`provider.clock`), so both sides move together. */
  clock: TestProvider['clock'];
  provider: TestProvider;
  client: ProviderClient;
  trace: FakeTraceWriter;
  logger: Logger;
  userId: string;
  close(): Promise<void>;
}

/** Comfortably longer than the provider's forced timeout delay, short enough to keep tests fast. */
const CLIENT_TIMEOUT_MS = 300;
const PROVIDER_TIMEOUT_DELAY_MS = 800;

/**
 * Real `startTestProvider` (over real HTTP) + a fresh in-memory core DB +
 * fake trace writer + silent logger — the shared environment every core
 * (no-LLM) test builds on. Wave 3 layers the engine services (proposals,
 * approvals, executors) on top; this harness intentionally stops here.
 */
export async function createCoreHarness(opts: CoreHarnessOptions = {}): Promise<CoreHarness> {
  const providerOptions: StartTestProviderOptions = {
    timeoutDelayMs: PROVIDER_TIMEOUT_DELAY_MS,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.clockStartMs !== undefined ? { clockStartMs: opts.clockStartMs } : {}),
  };
  const provider = await startTestProvider(providerOptions);

  const logger = createLogger({ name: 'core-harness', level: 'silent' });
  const client = createProviderClient({
    baseUrl: provider.url,
    timeoutMs: CLIENT_TIMEOUT_MS,
    logger,
  });

  const db = createTestDb();
  const trace = createFakeTraceWriter();

  return {
    db,
    clock: provider.clock,
    provider,
    client,
    trace,
    logger,
    userId: TEST_USER,
    async close(): Promise<void> {
      db.close();
      await provider.close();
    },
  };
}
