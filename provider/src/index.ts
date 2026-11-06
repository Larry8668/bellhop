import { createLogger } from '@bellhop/shared/logger';
import { systemClock } from '@bellhop/shared/clock';
import { createSeededRng } from '@bellhop/shared/rng';
import { loadConfig } from './config.js';
import { createAdjustableClock } from './clock.js';
import { bootstrapProvider } from './bootstrap.js';
import { createTimeoutControl } from './timeouts.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const config = loadConfig();
const logger = createLogger({ name: 'provider', level: config.LOG_LEVEL });
const clock = createAdjustableClock(systemClock);
const rng = createSeededRng(config.SEED);

const { engine, scenarios } = bootstrapProvider({
  dbPath: config.DB_PATH,
  seed: config.SEED,
  clock,
  logger,
  config,
});

const timeouts = createTimeoutControl(config.TIMEOUT_DELAY_MS);

const app = createApp({
  logger,
  clock,
  rng,
  seed: config.SEED,
  engine,
  scenarios,
  timeouts,
  adminEnabled: config.PROVIDER_ADMIN,
});

const { url } = await startServer({ app, port: config.PORT, logger });
logger.info({ url, adminEnabled: config.PROVIDER_ADMIN }, 'provider listening');
