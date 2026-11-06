import os from 'node:os';
import path from 'node:path';
import { mkdtempSync } from 'node:fs';
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '@bellhop/provider/testing';
import { openDatabase } from '../../src/db/open.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { migrateDb } from '../../src/db/migrate.js';
import { createApiApp } from '../../src/api/app.js';
import { createProviderClient, type ProviderClient } from '../../src/provider-client/index.js';
import { createMcpApp } from '../../src/mcp/index.js';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { DEFAULT_MCP_TEST_LIMITS } from './limits.js';
import { apiWiring, WEB_ORIGIN } from '../api/test-helpers.js';
import { startServer, type RunningServer } from './helpers.js';

export interface McpProposeTestContext {
  auth: Auth;
  logger: Logger;
  db: Database.Database;
  tp: TestProvider;
  providerClient: ProviderClient;
  server: RunningServer;
  apiApp: ReturnType<typeof createApiApp>;
  close(): Promise<void>;
}

/**
 * Same real-apps-behind-one-HTTP-server shape as `setupMcpTest`, but backed
 * by a real `startTestProvider` instead of a route stub: the propose/
 * approval tests need real `hold_slot`/`book` semantics (price, expiry,
 * `slot_unavailable`), not a scripted response per tool.
 */
export async function setupMcpProposeTest(): Promise<McpProposeTestContext> {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const db = openDatabase(':memory:', { logger });
  const auth = createAuth({
    db,
    secret: 'test-secret-do-not-use-in-production',
    baseUrl: 'http://localhost:3000',
    logger,
  });
  migrateDb(db, logger);

  const tp = await startTestProvider({ seed: 42 });
  const providerClient = createProviderClient({ baseUrl: tp.url, timeoutMs: 2000, logger });
  const queue = createUserQueue({ logger });
  const tracesDir = mkdtempSync(path.join(os.tmpdir(), 'bellhop-mcp-propose-trace-'));
  const wiring = apiWiring();

  const apiApp = createApiApp({
    auth,
    logger,
    providerClient,
    webOrigin: WEB_ORIGIN,
    db,
    clock: tp.clock,
    limits: DEFAULT_MCP_TEST_LIMITS,
    tracesDir,
    queue,
    ...wiring,
  });
  const mcpApp = createMcpApp({
    auth,
    providerClient,
    logger,
    db,
    clock: tp.clock,
    limits: DEFAULT_MCP_TEST_LIMITS,
    tracesDir,
    queue,
    webOrigin: WEB_ORIGIN,
    memory: wiring.memory,
  });

  const combined = new Hono();
  combined.route('/', apiApp);
  combined.route('/', mcpApp);

  const server = await startServer(combined);

  return {
    auth,
    logger,
    db,
    tp,
    providerClient,
    server,
    apiApp,
    async close() {
      await server.close();
      await tp.close();
    },
  };
}

/** Finds a seeded plumber in Indiranagar with an open slot, the same way `test/core/engine-harness.ts`'s `findProvider` does. */
export async function findBookableProvider(
  providerClient: ProviderClient,
  clock: TestProvider['clock'],
  userId: string,
): Promise<ProviderSummary> {
  const from = clock.now().toISOString();
  const to = new Date(clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await providerClient.search_providers(userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = providers.find((p) => p.slots.length >= 1);
  if (provider === undefined) throw new Error('seed has no plumber in Indiranagar with an open slot');
  return provider;
}
