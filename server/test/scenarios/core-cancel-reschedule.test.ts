import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { idempotencyKey } from '../../src/core/intents/service.js';
import { createIntentsRepo } from '../../src/core/repo/index.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { bookThroughEngine, findProvider, stateOf } from './helpers.js';

describe('core scenarios — cancel / reschedule', () => {
  let h: CoreHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await createCoreHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('S15 cancel 503 → bounded retry, approval required before anything happens', async ({ task }) => {
    task.meta.expected =
      'cancel without an approval is rejected and the booking stays confirmed; once approved, a 503 is retried with the same key and ends up cancelled';

    const bookingId = await bookThroughEngine(h, provider);
    const result = await h.engine.proposals.proposeCancel(h.userId, { booking_id: bookingId });
    if (!result.ok) throw new Error(result.code);
    const proposal = result.proposal;

    // No approval exists yet — the model cannot skip the Confirm button (invariant 1).
    const beforeApproval = await h.engine.executor.execute(h.userId, 'apr_never_approved');
    expect(beforeApproval).toEqual({ kind: 'rejected', reason: 'approval_not_valid' });
    expect(h.engine.bookings.list(h.userId)[0]?.status).toBe('confirmed');
    expect(h.providerBookings()[0]?.status).toBe('confirmed');

    const approval = h.approve(proposal);
    const key = idempotencyKey('cancel', approval.id);
    h.scenario('CANCEL_503_ONCE');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const intent = createIntentsRepo(h.db).get(key);
    expect(outcome).toMatchObject({ kind: 'cancelled', booking: { booking_id: bookingId, status: 'cancelled' } });
    expect(intent).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.providerBookings()[0]?.status).toBe('cancelled');
    expect(stateOf(h)).toBe('DONE');
    h.assertInvariants();

    task.meta.actual = `before_approval=${beforeApproval.kind} outcome=${outcome.kind} attempts=${intent?.attempts} provider_status=${h.providerBookings()[0]?.status}`;
  });

  it('S16 reschedule conflict → alternatives, old approval cannot be reused, a fresh approval is required', async ({
    task,
  }) => {
    task.meta.expected =
      'a reschedule conflict returns alternatives and leaves the booking unchanged; proposing one of the alternatives needs a brand new proposal and approval — the old (now-consumed) approval is rejected if reused';

    const bookingId = await bookThroughEngine(h, provider);
    const result = await h.engine.proposals.proposeReschedule(h.userId, {
      booking_id: bookingId,
      slot: provider.slots[1]!,
    });
    if (!result.ok) throw new Error(result.code);
    const oldApproval = h.approve(result.proposal);
    h.scenario('RESCHEDULE_CONFLICT');

    const outcome = await h.engine.executor.execute(h.userId, oldApproval.id);
    if (outcome.kind !== 'slot_gone') throw new Error(`unexpected ${outcome.kind}`);

    expect(outcome.reason).toBe('slot_conflict');
    expect(outcome.alternatives.length).toBeGreaterThan(0);
    expect(h.providerBookings()[0]?.slot).toEqual(provider.slots[0]);
    expect(stateOf(h)).toBe('PROPOSED');

    // A fresh proposal + approval for one of the alternatives is a genuinely new card.
    const alternative = outcome.alternatives[0]!;
    const freshResult = await h.engine.proposals.proposeReschedule(h.userId, { booking_id: bookingId, slot: alternative });
    if (!freshResult.ok) throw new Error(freshResult.code);
    expect(freshResult.proposal.id).not.toBe(result.proposal.id);
    expect(freshResult.proposal.hash).not.toBe(result.proposal.hash);

    // The old approval — already consumed by the conflicting attempt — cannot restart the action.
    const replay = await h.engine.executor.execute(h.userId, oldApproval.id);
    expect(replay).toEqual({ kind: 'rejected', reason: 'approval_already_consumed' });
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind}(${outcome.reason}) alternatives=${outcome.alternatives.length} fresh_proposal_new=${freshResult.proposal.id !== result.proposal.id} old_approval_reused=${replay.kind}`;
  });
});
