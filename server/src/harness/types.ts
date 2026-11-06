/**
 * Pinned memory contract shared with the memory work (plan §11).
 * The store itself lives under `server/src/memory` and is not created here.
 */

export type FactKind = 'explicit' | 'inferred';
export type FactStatus = 'active' | 'unconfirmed' | 'forgotten';
export interface MemoryFact { id: string; key: string; value: string; kind: FactKind; status: FactStatus; tags: string[] }
export interface ContextLogEntry {
  userId: string; runId: string; step: number;
  estTokens: number;                 // chars/4 estimate before the call
  factIds: string[];                 // ids of facts injected into the prompt
  sections: Record<string, number>;  // est tokens per section: system, memories, task, history, tools
}
export interface HarnessMemory {
  /** Only `active` facts relevant to service/area (tag or key match) plus untagged general prefs; capped (~800 tokens). Never forgotten/unconfirmed. */
  selectForContext(userId: string, ctx: { service?: string | null; area?: string | null }): MemoryFact[];
  /** explicit -> status active; inferred -> status unconfirmed. Same key + explicit overwrites the old active value. */
  remember(userId: string, input: { key: string; value: string; kind: FactKind; tags?: string[] }): MemoryFact;
  /** Marks every fact with that key forgotten. Returns true if any changed. */
  forget(userId: string, key: string): boolean;
  /** Active + unconfirmed facts (never forgotten) for display / get_profile. */
  getProfile(userId: string): MemoryFact[];
  /** Writes one context_log row. */
  logContext(entry: ContextLogEntry): void;
}

/** Live trace event for the UI panel (plan §13). `detail` is already sanitized. */
export interface HarnessEvent {
  ts: string;
  type: string;
  summary: string;
  detail?: unknown;
}
