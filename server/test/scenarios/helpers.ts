import type { ProviderSummary, Slot } from '@bellhop/shared/contracts';
import type { Proposal, TaskStateName } from '../../src/core/types.js';
import type { CoreHarness } from '../helpers/core-harness.js';

/** Hold TTL used across the provider's seeded config (plan §4, `DEFAULT_ENGINE_CONFIG.holdTtlMs`). */
export const HOLD_TTL_MS = 10 * 60_000;

/** A provider with 3+ open slots, so every test has room for an "alternative" slot. Resets the call log. */
export async function findProvider(h: CoreHarness): Promise<ProviderSummary> {
  const from = h.clock.now().toISOString();
  const to = new Date(h.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await h.client.search_providers(h.userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = providers.find((p) => p.slots.length >= 3);
  if (provider === undefined) throw new Error('seed has no provider with 3+ slots');
  h.providerCalls().length = 0;
  return provider;
}

/** Proposes a booking for `slot` (defaults to the provider's first slot). Resets the call log. */
export async function proposeBooking(
  h: CoreHarness,
  provider: ProviderSummary,
  slot: Slot = provider.slots[0]!,
): Promise<Proposal> {
  const result = await h.engine.proposals.proposeBooking(h.userId, {
    provider_id: provider.id,
    provider_name: provider.name,
    service: provider.service,
    slot,
  });
  if (!result.ok) throw new Error(`proposeBooking failed: ${result.code}`);
  h.providerCalls().length = 0;
  return result.proposal;
}

/** Books `slot` end-to-end through the executor and resets the errand so a cancel/reschedule can be proposed next. */
export async function bookThroughEngine(
  h: CoreHarness,
  provider: ProviderSummary,
  slot: Slot = provider.slots[0]!,
): Promise<string> {
  const approval = h.approve(await proposeBooking(h, provider, slot));
  h.scenario('BOOK_SUCCESS');
  const outcome = await h.engine.executor.execute(h.userId, approval.id);
  if (outcome.kind !== 'booked') throw new Error(`setup booking failed: ${outcome.kind}`);
  h.engine.stateMachine.transition(h.userId, 'GATHERING', 'new errand');
  h.providerCalls().length = 0;
  return outcome.booking.booking_id;
}

export function stateOf(h: CoreHarness): TaskStateName {
  return h.engine.taskState.get(h.userId)?.state ?? 'GATHERING';
}

export function errorEvents(h: CoreHarness) {
  return h.trace.events.filter((e) => e.type === 'error');
}

export function approvalEvents(h: CoreHarness) {
  return h.trace.events.filter((e) => e.type === 'approval');
}

export function toolCallEvents(h: CoreHarness) {
  return h.trace.events.filter((e) => e.type === 'tool_call');
}

export function stateTransitionPath(h: CoreHarness): string[] {
  return h.trace.events.flatMap((e) => (e.type === 'state_transition' ? [e.to] : []));
}
