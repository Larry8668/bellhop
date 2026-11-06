import { createLogger } from '@bellhop/shared/logger';
import { systemClock } from '@bellhop/shared/clock';
import { createSeededRng } from '@bellhop/shared/rng';
import { loadConfig } from './config.js';
import { createApp } from './app.js';
import { startServer } from './server.js';

const config = loadConfig();
const logger = createLogger({ name: 'provider', level: config.LOG_LEVEL });
const clock = systemClock;
const rng = createSeededRng(config.SEED);

const app = createApp({ logger, clock, rng, seed: config.SEED });

const { url } = await startServer({ app, port: config.PORT, logger });
logger.info({ url }, 'provider listening');
