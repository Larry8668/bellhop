import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import type { ToolName } from '@bellhop/shared/contracts';
import { systemClock } from '@bellhop/shared/clock';
import { Hono } from 'hono';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { openDatabase } from '../../src/db/open.js';
import { createAuth, type Auth } from '../../src/auth/auth.js';
import { migrateDb } from '../../src/db/migrate.js';
import { createApiApp } from '../../src/api/app.js';
import { createProviderClient } from '../../src/provider-client/index.js';
import { createMcpApp } from '../../src/mcp/index.js';
import { signUpAndSignIn, WEB_ORIGIN, type SignedUpUser } from '../api/test-helpers.js';
import { startStubProvider, type StubProvider, type StubProviderRoute } from '../helpers/stub-provider.js';
import { startServer, type RunningServer } from './helpers.js';

const MCP_TEST_LIMITS = { statusChecks: 3, retriesPerTool: 2 } as const;

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

  const apiApp = createApiApp({
    auth,
    logger,
    providerClient,
    webOrigin: WEB_ORIGIN,
    db,
    clock: systemClock,
    limits: MCP_TEST_LIMITS,
    tracesDir,
    queue,
  });
  const mcpApp = createMcpApp({ auth, providerClient, logger });

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
export async function createApiKeyUser(
  apiApp: ReturnType<typeof createApiApp>,
): Promise<{ user: SignedUpUser; apiKey: string }> {
  const user = await signUpAndSignIn(apiApp);
  const createRes = await apiApp.request('/api/keys', {
    method: 'POST',
    headers: { cookie: user.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'mcp test key' }),
  });
  if (createRes.status !== 201) {
    throw new Error(`api key creation failed: ${createRes.status} ${await createRes.text()}`);
  }
  const { key } = (await createRes.json()) as { key: string };
  return { user, apiKey: key };
}
