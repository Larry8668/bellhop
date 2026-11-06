import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import { systemClock } from '@bellhop/shared/clock';
import type { ToolName } from '@bellhop/shared/contracts';
import { Hono } from 'hono';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { openDatabase } from '../../src/db/open.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { migrateDb } from '../../src/db/migrate.js';
import { createApiApp } from '../../src/api/app.js';
import { createProviderClient } from '../../src/provider-client/index.js';
import { createMcpApp } from '../../src/mcp/index.js';
import { DEFAULT_MCP_TEST_LIMITS } from './limits.js';
import { apiWiring, createApiKeyUser as createApiKeyUserHelper, WEB_ORIGIN } from '../api/test-helpers.js';
import type { HarnessMemory } from '../../src/wiring/deps.js';
import { startStubProvider, type StubProvider, type StubProviderRoute } from '../helpers/stub-provider.js';
import { startServer, type RunningServer } from './helpers.js';


export interface McpTestContext {
  auth: Auth;
  logger: Logger;
  stub: StubProvider;
  server: RunningServer;
  apiApp: ReturnType<typeof createApiApp>;
  close(): Promise<void>;
}

/**
 * Wires a real Better Auth instance, a stub provider, and the actual API +
 * MCP Hono apps behind one HTTP server — everything an MCP route test needs
 * (session cookies and the MCP SDK client both require a real URL, not
 * `app.request(...)`).
 */
export async function setupMcpTest(
  routes: Partial<Record<ToolName, StubProviderRoute>>,
  opts: { memory?: HarnessMemory } = {},
): Promise<McpTestContext> {
  const logger = createLogger({ name: 'test', level: 'silent' });
  const db = openDatabase(':memory:', { logger });
  const auth = createAuth({
    db,
    secret: 'test-secret-do-not-use-in-production',
    baseUrl: 'http://localhost:3000',
    logger,
  });
  migrateDb(db, logger);

  const stub = await startStubProvider(routes);
  const providerClient = createProviderClient({ baseUrl: stub.url, timeoutMs: 5000, logger });
  const tracesDir = mkdtempSync(path.join(tmpdir(), 'bellhop-mcp-test-'));
  const queue = createUserQueue({ logger });
  const wiring = apiWiring(opts.memory === undefined ? {} : { memory: opts.memory });

  const apiApp = createApiApp({
    auth,
    logger,
    providerClient,
    webOrigin: WEB_ORIGIN,
    db,
    clock: systemClock,
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
    clock: systemClock,
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
    stub,
    server,
    apiApp,
    async close() {
      await server.close();
      await stub.close();
    },
  };
}

/** Signs up a fresh user through the real HTTP routes and mints an API key for it. */
export const createApiKeyUser = createApiKeyUserHelper;
