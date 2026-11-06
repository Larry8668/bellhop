import { createCoreEngine } from './core/engine.js';
import { systemClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import { loadConfig } from './config.js';
import { resolvePendingIntents } from './core/recovery/resolve-intents.js';
import { createTraceWriter } from './trace/writer.js';
import { openDatabase } from './db/open.js';
import { createAuth } from './auth/auth.js';
import { migrateDb } from './db/migrate.js';
import { createProviderClient } from './provider-client/index.js';
import { createApiApp } from './api/app.js';
import { createUserQueue } from './core/queue/user-queue.js';
import { createEventBus } from './events/bus.js';
import { createMcpApp } from './mcp/index.js';
import { createProviderAdminClient } from './provider-client/index.js';
import { startServer } from './server.js';
import { createAgentModel, createMemoryService, createProactive, runTurn } from './wiring/deps.js';

const DEFAULT_SECRET = 'dev-secret-change-me';

const config = loadConfig();
const logger = createLogger({ name: 'server', level: config.LOG_LEVEL });

if (config.BETTER_AUTH_SECRET === DEFAULT_SECRET) {
  logger.warn(
    'BETTER_AUTH_SECRET is the default dev value — set it before deploying',
  );
}

const db = openDatabase(config.DB_PATH, { logger });

const auth = createAuth({
  db,
  secret: config.BETTER_AUTH_SECRET,
  baseUrl: config.BETTER_AUTH_URL,
  trustedOrigins: [config.WEB_ORIGIN],
  logger,
});
const applied = migrateDb(db, logger);
logger.info({ count: applied.length }, `migrations: ${applied.length} applied`);

const providerClient = createProviderClient({
  baseUrl: config.PROVIDER_URL,
  timeoutMs: config.PROVIDER_TIMEOUT_MS,
  logger,
});

// Plan §8: resolve every pending/unknown intent before accepting a single turn.
const recovery = await resolvePendingIntents({
  db,
  clock: systemClock,
  providerClient,
  trace: createTraceWriter({
    dir: config.TRACES_DIR,
    runId: `recovery_${systemClock.now().toISOString().replace(/[:.]/g, '-')}`,
    clock: systemClock,
  }),
  logger,
});
logger.info(recovery, 'startup recovery finished');

// One queue for every surface (API, MCP, proactive) so a user's actions never interleave (plan §8).
const queue = createUserQueue({ logger });
const turnLimits = {
  modelCalls: config.LIMIT_MODEL_CALLS_PER_TURN,
  toolCalls: config.LIMIT_TOOL_CALLS_PER_TURN,
  wallClockMs: config.LIMIT_TURN_WALL_CLOCK_MS,
  statusChecks: config.LIMIT_STATUS_CHECKS,
  retriesPerTool: config.LIMIT_RETRIES_PER_TOOL,
};
const model = createAgentModel(config);
const memory = createMemoryService({ db, clock: systemClock });
const bus = createEventBus();
const workflowDeps = {
  db,
  clock: systemClock,
  limits: {
    statusChecks: config.LIMIT_STATUS_CHECKS,
    retriesPerTool: config.LIMIT_RETRIES_PER_TOOL,
  },
  tracesDir: config.TRACES_DIR,
  queue,
};
const proactive = createProactive({
  db,
  clock: systemClock,
  providerClient,
  logger,
  engine: createCoreEngine({
    db,
    clock: systemClock,
    providerClient,
    trace: createTraceWriter({ dir: config.TRACES_DIR, runId: `proactive_${Date.now()}`, clock: systemClock }),
    logger,
    limits: { statusChecks: config.LIMIT_STATUS_CHECKS, retriesPerTool: config.LIMIT_RETRIES_PER_TOOL },
  }),
  queue,
  prefs: (userId) =>
    memory.selectForContext(userId, {}).map((fact) => ({ key: fact.key, value: fact.value })),
  notify: (userId, message) => {
    bus.publish(userId, {
      ts: systemClock.now().toISOString(),
      type: 'proactive',
      summary: message.text,
      detail: { proposalId: message.proposalId ?? null },
    });
  },
});
proactive.start(config.PROACTIVE_POLL_MS);
logger.info({ intervalMs: config.PROACTIVE_POLL_MS, devRoutes: config.DEV_ROUTES }, 'proactive poller started');

const app = createApiApp({
  auth,
  logger,
  providerClient,
  webOrigin: config.WEB_ORIGIN,
  ...workflowDeps,
  model,
  memory,
  bus,
  turnLimits,
  runTurn,
  proactive,
  devRoutes: config.DEV_ROUTES,
  providerAdmin: createProviderAdminClient({ baseUrl: config.PROVIDER_URL }),
});
app.route('/', createMcpApp({ auth, providerClient, logger, webOrigin: config.WEB_ORIGIN, memory, ...workflowDeps }));

const { url } = await startServer({ app, port: config.SERVER_PORT, logger });
logger.info({ url, mcp: `${url}/mcp` }, 'server listening');
