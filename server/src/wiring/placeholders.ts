import type { LanguageModel } from 'ai';
import { MockLanguageModelV4 } from 'ai/test';
import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { z } from 'zod';
import type { Config } from '../config.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import type { ProviderClient } from '../provider-client/client.js';

/**
 * Stand-ins for harness, memory, and proactive, which land on parallel
 * branches. Operations throw `not wired`; `start` only logs, so this
 * process can boot. `wiring/deps.ts` re-exports this file until those
 * modules exist.
 */

export type AppConfig = Config;

export const memoryFactSchema = z.object({
  id: z.string().min(1),
  key: z.string().min(1),
  value: z.string(),
  kind: z.enum(['explicit', 'inferred']),
  status: z.enum(['active', 'unconfirmed', 'forgotten']),
});
export type MemoryFact = z.infer<typeof memoryFactSchema>;

/** Pinned harness memory surface (plan §9, §11). `selectForContext` is what a turn is allowed to see. */
export interface HarnessMemory {
  selectForContext(userId: string, scope: { service?: string; area?: string }): MemoryFact[];
  remember(userId: string, fact: { key: string; value: string }): void;
  forget(userId: string, key: string): void;
  getProfile(userId: string): MemoryFact[];
  logContext(entry: unknown): void;
}

export type TurnExit = 'ok' | 'needs_input' | 'proposed' | 'limit_reached' | 'failed' | 'booked' | 'unconfirmed';

export interface TurnEvent {
  ts: string;
  type: string;
  summary: string;
  detail?: unknown;
}

/** Per-turn budgets from config (plan §9). Distinct from the executor's status-check limits. */
export interface TurnLimits {
  modelCalls: number;
  toolCalls: number;
  wallClockMs: number;
  statusChecks: number;
  retriesPerTool: number;
}

export interface RunTurnDeps {
  db: Database.Database;
  clock: Clock;
  model: LanguageModel;
  providerClient: ProviderClient;
  logger: Logger;
  tracesDir: string;
  limits: TurnLimits;
  memory?: HarnessMemory;
  onEvent?: (event: TurnEvent) => void;
}

export interface RunTurnResult {
  reply: string;
  exit: TurnExit;
  proposalId?: string;
  runId: string;
}

export type RunTurn = (deps: RunTurnDeps, input: { userId: string; text: string }) => Promise<RunTurnResult>;

export interface Proactive {
  tick(): Promise<void>;
  start(intervalMs: number): () => void;
}

export interface CreateProactiveDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  logger: Logger;
  tracesDir: string;
  limits: TurnLimits;
  queue: UserQueue;
  prefs?: (userId: string) => { key: string; value: string }[];
  notify?: (userId: string, message: { text: string; proposalId?: string }) => void;
}

function notWired(): never {
  throw new Error('not wired');
}

export const runTurn: RunTurn = async () => {
  notWired();
};

export function createAgentModel(config: AppConfig): LanguageModel {
  void config;
  return new MockLanguageModelV4({
    doGenerate: () => notWired(),
  });
}

export function createMemoryService(deps: { db: Database.Database; clock: Clock }): HarnessMemory {
  void deps;
  return {
    selectForContext: () => notWired(),
    remember: () => notWired(),
    forget: () => notWired(),
    getProfile: () => notWired(),
    logContext: () => notWired(),
  };
}

export function createProactive(deps: CreateProactiveDeps): Proactive {
  return {
    tick: async () => {
      notWired();
    },
    start(intervalMs) {
      deps.logger.warn({ intervalMs }, 'proactive poller not wired');
      return () => {};
    },
  };
}
