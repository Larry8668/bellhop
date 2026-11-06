// Real modules; `placeholders.ts` now only supplies the shared structural types and the fact schema.
export { createAgentModel, runTurn } from '../harness/index.js';
export { createMemoryService } from '../memory/index.js';
export { createProactive } from '../proactive/index.js';
export { memoryFactSchema } from './placeholders.js';
export type { HarnessMemory, MemoryFact } from '../memory/index.js';
export type { RunTurnDeps, TurnExit, TurnLimits, TurnResult as RunTurnResult } from '../harness/index.js';
export type { HarnessEvent as TurnEvent } from '../harness/index.js';
export type { Proactive, ProactiveDeps as CreateProactiveDeps } from '../proactive/index.js';
export type { AppConfig } from './placeholders.js';
export type RunTurn = typeof import('../harness/index.js').runTurn;
