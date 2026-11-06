import { createHash } from 'node:crypto';
import type { Slot } from '@bellhop/shared/contracts';
import type { Action } from '../types.js';

/**
 * Deterministic key order so `{a:1,b:2}` and `{b:2,a:1}` fingerprint the
 * same. Mirrors `provider/src/engine/idempotency.ts`'s `canonicalJson` —
 * kept local rather than imported because `server` and `provider` are
 * separate workspaces and this is a small pure function, not shared state.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries
    .map(([key, val]) => `${JSON.stringify(key)}:${canonicalJson(val)}`)
    .join(',')}}`;
}

export interface ProposalHashInput {
  action: Action;
  provider_id: string;
  slot: Slot;
  price: number;
  /** Always present — `null` for `book` (plan §7's hash covers cancel/reschedule too, which carry a `booking_id`). */
  booking_id: string | null;
}

/**
 * `sha256(action, provider_id, slot, price, booking_id)` (plan §7). Used
 * both to stamp a new proposal and, at execute time, to recompute from the
 * actual hold/booking — identical hash means proceed without re-asking,
 * different hash (price moved, slot changed) means the approval is void.
 */
export function proposalHash(input: ProposalHashInput): string {
  const canonical: ProposalHashInput = {
    action: input.action,
    provider_id: input.provider_id,
    slot: { start: input.slot.start, end: input.slot.end },
    price: input.price,
    booking_id: input.booking_id,
  };
  return createHash('sha256').update(canonicalJson(canonical)).digest('hex');
}
