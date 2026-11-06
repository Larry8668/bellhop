import { randomUUID } from 'node:crypto';

/**
 * Prefixed random ids for core domain rows (`prop_…`, `appr_…`, `conv_…`,
 * `msg_…`). Ids are not part of core determinism — only the clock is (plan
 * §9 "inject clock and rng") — so `crypto.randomUUID()` is fine to call
 * directly here, unlike `Date.now()`/`Math.random()` elsewhere in core.
 */
export function newId(prefix: string): string {
  return `${prefix}_${randomUUID()}`;
}
