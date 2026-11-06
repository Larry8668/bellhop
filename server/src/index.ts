import { createLogger } from '@bellhop/shared/logger';
import { loadConfig } from './config.js';
import { openDatabase } from './db/open.js';
import { createAuth } from './auth/auth.js';
import { migrateDb } from './db/migrate.js';
import { createProviderClient } from './provider-client/index.js';
import { createApiApp } from './api/app.js';
import { createMcpApp } from './mcp/index.js';
import { startServer } from './server.js';

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

const app = createApiApp({ auth, logger, providerClient, webOrigin: config.WEB_ORIGIN });
app.route('/', createMcpApp({ auth, providerClient, logger }));

const { url } = await startServer({ app, port: config.SERVER_PORT, logger });
logger.info({ url, mcp: `${url}/mcp` }, 'server listening');
