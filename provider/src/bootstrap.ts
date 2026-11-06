import type Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import { createSeededRng } from '@bellhop/shared/rng';
import type { AdjustableClock } from './clock.js';
import type { ProviderConfig } from './config.js';
import { openProviderDb } from './db/open.js';
import { getMeta } from './db/meta.js';
import { applySchema } from './db/schema.js';
import { seedProviders } from './db/seed.js';
import { createEngine, DEFAULT_ENGINE_CONFIG, type ProviderEngine } from './engine/engine.js';
import { createScenarioQueue, type ScenarioQueue } from './scenarios.js';

export interface BootstrapResult {
  engine: ProviderEngine;
  scenarios: ScenarioQueue;
  db: Database.Database;
}

/**
 * Opens (and seeds, if empty) the provider database and wires up the engine.
 * A persisted DB survives restarts with its existing data (plan §4) — only
 * `meta.seed` being absent triggers the initial seed; `POST /__admin/reset`
 * is the only thing that reseeds an already-seeded database.
 */
export function bootstrapProvider(deps: {
  dbPath: string;
  seed: number;
  clock: AdjustableClock;
  logger: Logger;
  config: ProviderConfig;
}): BootstrapResult {
  const { dbPath, seed, clock, logger, config } = deps;
  const log = childLogger(logger, 'bootstrap');

  const db = openProviderDb(dbPath, { logger });
  const applied = applySchema(db, logger);
  log.info({ count: applied.length }, `migrations: ${applied.length} applied`);

  const rng = createSeededRng(seed);

  if (getMeta(db, 'seed') === undefined) {
    seedProviders(db, { rng, clock, seed });
    log.info({ seed, dbPath }, 'provider database seeded');
  } else {
    log.info({ dbPath }, 'provider database already seeded, reusing existing data');
  }

  const scenarios = createScenarioQueue();
  const engine = createEngine({
    db,
    clock,
    rng,
    scenarios,
    logger,
    config: {
      ...DEFAULT_ENGINE_CONFIG,
      holdPriceDriftProbability: config.HOLD_PRICE_DRIFT_PROB,
      bookSuccessP: config.BOOK_SUCCESS_P,
      bookSlotTakenP: config.BOOK_SLOT_TAKEN_P,
    },
  });

  return { engine, scenarios, db };
}
