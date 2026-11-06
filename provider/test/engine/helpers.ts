import { createLogger } from '@bellhop/shared/logger';
import { createFakeClock, type FakeClock } from '@bellhop/shared/clock';
import { createSeededRng, type Rng } from '@bellhop/shared/rng';
import { createAdjustableClock, type AdjustableClock } from '../../src/clock.js';
import { openProviderDb } from '../../src/db/open.js';
import { applySchema } from '../../src/db/schema.js';
import { seedProviders } from '../../src/db/seed.js';
import { createScenarioQueue, type ScenarioQueue } from '../../src/scenarios.js';
import { createEngine, DEFAULT_ENGINE_CONFIG, type EngineConfig, type ProviderEngine } from '../../src/engine/engine.js';

export const TEST_START_MS = Date.UTC(2026, 10, 1, 4, 0, 0); // 2026-11-01T04:00:00Z = 09:30 IST
export const TEST_USER = 'user_1';
export const OTHER_USER = 'user_2';

export interface TestEngine {
  engine: ProviderEngine;
  db: ReturnType<typeof openProviderDb>;
  clock: AdjustableClock;
  base: FakeClock;
  rng: Rng;
  scenarios: ScenarioQueue;
}

export function createTestEngine(opts?: {
  seed?: number;
  startMs?: number;
  config?: Partial<EngineConfig>;
}): TestEngine {
  const seed = opts?.seed ?? 42;
  const logger = createLogger({ name: 'test', level: 'silent' });
  const db = openProviderDb(':memory:', { logger });
  applySchema(db, logger);

  const base = createFakeClock(opts?.startMs ?? TEST_START_MS);
  const clock = createAdjustableClock(base);
  const rng = createSeededRng(seed);
  const scenarios = createScenarioQueue();

  seedProviders(db, { rng, clock, seed });

  const config: EngineConfig = { ...DEFAULT_ENGINE_CONFIG, ...opts?.config };
  const engine = createEngine({ db, clock, rng, scenarios, logger, config });

  return { engine, db, clock, base, rng, scenarios };
}
