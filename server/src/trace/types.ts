/**
 * Trace event shapes (plan §13). One JSONL file per run; `run_id`/`ts` are
 * stamped by the writer, never supplied by callers, so every event is
 * comparable across the file regardless of source.
 */

interface TraceEventBase {
  run_id: string;
  turn_id?: string;
  ts: string;
}

export interface StateTransitionEvent extends TraceEventBase {
  type: 'state_transition';
  from: string;
  to: string;
  reason?: string;
}

export interface ModelCallEvent extends TraceEventBase {
  type: 'model_call';
  model: string;
  latency_ms: number;
  tokens_in: number;
  tokens_out: number;
  est_cost_usd: number;
  finish_reason?: string;
}

export interface ToolCallEvent extends TraceEventBase {
  type: 'tool_call';
  tool: string;
  args: unknown;
  result_sanitized: unknown;
  latency_ms: number;
  ok: boolean;
}

export interface ApprovalEvent extends TraceEventBase {
  type: 'approval';
  proposal_id: string;
  approval_id?: string;
  action: string;
  hash: string;
  outcome: 'created' | 'consumed' | 'void' | 'rejected';
}

export interface IntentEvent extends TraceEventBase {
  type: 'intent';
  idempotency_key: string;
  action: string;
  status: string;
}

export interface ErrorEvent extends TraceEventBase {
  type: 'error';
  where: string;
  message: string;
}

export type TraceEvent =
  | StateTransitionEvent
  | ModelCallEvent
  | ToolCallEvent
  | ApprovalEvent
  | IntentEvent
  | ErrorEvent;

/**
 * `Omit<Union, K>` does not distribute over a discriminated union in
 * TypeScript — it collapses to the keys common to every member, dropping
 * variant-specific fields like `tool` or `from`. This distributes `Omit`
 * per-member so callers still get the right fields for each `type`.
 */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type TraceEventInput = DistributiveOmit<TraceEvent, 'run_id' | 'ts'>;
