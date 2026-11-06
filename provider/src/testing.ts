import { createLogger } from '@bellhop/shared/logger';
import { createFakeClock } from '@bellhop/shared/clock';
import { createSeededRng } from '@bellhop/shared/rng';
import { createApp } from './app.js';
import { bootstrapProvider } from './bootstrap.js';
import { createAdjustableClock, type AdjustableClock } from './clock.js';
import type { ProviderConfig } from './config.js';
import type { ProviderEngine } from './engine/engine.js';
import type { ScenarioQueue } from './scenarios.js';
import { startServer } from './server.js';
import { createTimeoutControl } from './timeouts.js';

export interface TestProvider {
  url: string;
  port: number;
  engine: ProviderEngine;
  clock: AdjustableClock;
  scenarios: ScenarioQueue;
  close(): Promise<void>;
}

export interface StartTestProviderOptions {
  seed?: number;
  clockStartMs?: number;
  adminEnabled?: boolean;
  timeoutDelayMs?: number;
  holdPriceDriftProbability?: number;
  logLevel?: string;
}

/** `2026-11-06T09:00:00+05:30`, the fixed "now" every test provider starts at. */
const DEFAULT_CLOCK_START_MS = Date.parse('2026-11-06T09:00:00+05:30');

/**
 * Boots a real in-memory provider over a real HTTP server for tests
 * (consumed by the backend as `@bellhop/provider/testing`). Defaults favor
 * fast, deterministic tests: `:memory:` db, fixed seed, fake clock, no
 * price drift, a short timeout delay, and a silent logger.
 */
export async function startTestProvider(opts: StartTestProviderOptions = {}): Promise<TestProvider> {
  const seed = opts.seed ?? 42;
  const clockStartMs = opts.clockStartMs ?? DEFAULT_CLOCK_START_MS;
  const adminEnabled = opts.adminEnabled ?? true;
  const timeoutDelayMs = opts.timeoutDelayMs ?? 20;
  const holdPriceDriftProbability = opts.holdPriceDriftProbability ?? 0;
  const logLevel = opts.logLevel ?? 'silent';

  const logger = createLogger({ name: 'provider-test', level: logLevel });
  const clock = createAdjustableClock(createFakeClock(clockStartMs));
  const rng = createSeededRng(seed);

  const config: ProviderConfig = {
    PORT: 0,
    SEED: seed,
    PROVIDER_ADMIN: adminEnabled,
    LOG_LEVEL: logLevel,
    DB_PATH: ':memory:',
    TIMEOUT_DELAY_MS: timeoutDelayMs,
    HOLD_PRICE_DRIFT_PROB: holdPriceDriftProbability,
    BOOK_SUCCESS_P: 0.7,
    BOOK_SLOT_TAKEN_P: 0.15,
  };

  const { engine, scenarios } = bootstrapProvider({
    dbPath: ':memory:',
    seed,
    clock,
    logger,
    config,
  });

  const timeouts = createTimeoutControl(timeoutDelayMs);

  const app = createApp({ logger, clock, rng, seed, engine, scenarios, timeouts, adminEnabled });

  const { port, url, close } = await startServer({ app, port: 0, logger });

  return { url, port, engine, clock, scenarios, close };
}
