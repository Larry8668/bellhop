import type Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';
import type { Rng } from '@bellhop/shared/rng';
import type { AdjustableClock } from '../clock.js';
import type { ScenarioQueue } from '../scenarios.js';

export interface EngineConfig {
  holdTtlMs: number;
  holdPriceDriftProbability: number;
  bookSuccessP: number;
  bookSlotTakenP: number;
  timeoutBookedP: number;
}

export const DEFAULT_ENGINE_CONFIG: EngineConfig = {
  holdTtlMs: 600_000,
  holdPriceDriftProbability: 0.15,
  bookSuccessP: 0.7,
  bookSlotTakenP: 0.15,
  timeoutBookedP: 0.5,
};

/**
 * Shared dependencies threaded through every engine module. `rng` is
 * mutable: `admin.reset` swaps in a fresh seeded generator.
 */
export interface EngineContext {
  db: Database.Database;
  clock: AdjustableClock;
  rng: Rng;
  scenarios: ScenarioQueue;
  logger: Logger;
  config: EngineConfig;
}
