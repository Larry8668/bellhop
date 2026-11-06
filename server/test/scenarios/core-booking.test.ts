import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { ProviderError } from '../../src/provider-client/errors.js';
import { idempotencyKey } from '../../src/core/intents/service.js';
import { createIntentsRepo } from '../../src/core/repo/index.js';
import { resolvePendingIntents } from '../../src/core/recovery/resolve-intents.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { findProvider, proposeBooking, stateOf, toolCallEvents } from './helpers.js';

/**
 * Plan §16 "Core (no model)" scenarios that haven't already moved through
 * the booking machinery: S06, S09–S11, S13–S14. Scenarios already covered
 * in `server/test/core/actions/executor.test.ts` are re-asserted here too
 * — that file is unit coverage for the executor, this suite is the EVALS
 * source of truth for plan numbering.
 */
describe('core scenarios — booking', () => {
  let h: CoreHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await createCoreHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('S06 model fakes approval via tool args → rejected, zero provider calls, zero bookings', async ({ task }) => {
    task.meta.expected =
      'the LLM only ever calls propose_*; an approval id it fabricates, or a proposal id passed where an approval id belongs, is rejected before any provider call and before any booking exists';

    const proposal = await proposeBooking(h, provider);

    const fabricated = await h.engine.executor.execute(h.userId, 'apr_forged_by_model');
    const usingProposalId = await h.engine.executor.execute(h.userId, proposal.id);

    expect(fabricated).toEqual({ kind: 'rejected', reason: 'approval_not_valid' });
    expect(usingProposalId).toEqual({ kind: 'rejected', reason: 'approval_not_valid' });
    expect(h.providerCalls()).toHaveLength(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `fabricated=${fabricated.kind}(${(fabricated as { reason?: string }).reason}) proposal_id_as_approval=${usingProposalId.kind}(${(usingProposalId as { reason?: string }).reason}) providerCalls=${h.providerCalls().length} bookings=${h.providerBookings().length}`;
  });

  it('S09 timeout after success → verified via get_booking_status, no duplicate booking', async ({ task }) => {
    task.meta.expected =
      "book() times out but the provider actually booked it; get_booking_status verifies success — outcome booked, exactly one provider booking, intent succeeded, state DONE, the trace shows the status check";

    const approval = h.approve(await proposeBooking(h, provider));
    const key = idempotencyKey('book', approval.id);
    h.scenario('TIMEOUT_BOOKED');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const intent = createIntentsRepo(h.db).get(key);
    const statusCheck = toolCallEvents(h).find((e) => e.type === 'tool_call' && e.tool === 'get_booking_status');
    expect(outcome).toMatchObject({ kind: 'booked', replayed: false });
    expect(h.providerBookings()).toHaveLength(1);
    expect(intent?.status).toBe('succeeded');
    expect(stateOf(h)).toBe('DONE');
    expect(statusCheck).toBeDefined();
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind} bookings=${h.providerBookings().length} intent=${intent?.status} state=${stateOf(h)} trace_get_booking_status=${statusCheck !== undefined}`;
  });

  it('S10 timeout not booked → safe retry with the same idempotency key → booked once', async ({ task }) => {
    task.meta.expected =
      'book() times out and the provider never booked it; the retry reuses the SAME idempotency key — outcome booked, exactly one booking';

    const approval = h.approve(await proposeBooking(h, provider));
    const key = idempotencyKey('book', approval.id);
    h.scenario('TIMEOUT_NOT_BOOKED', 'BOOK_SUCCESS');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const bookCalls = h.providerCalls().filter((c) => c.tool === 'book');
    const bookKeys = bookCalls.map((c) => (c.body as { idempotency_key: string }).idempotency_key);
    const intent = createIntentsRepo(h.db).get(key);
    expect(outcome).toMatchObject({ kind: 'booked' });
    expect(bookCalls).toHaveLength(2);
    expect(bookKeys).toEqual([key, key]);
    expect(intent).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.providerBookings()).toHaveLength(1);
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind} bookings=${h.providerBookings().length} intent=${intent?.status} attempts=${intent?.attempts} book_keys=${JSON.stringify(bookKeys)}`;
  });

  it('S11 book → slot_taken → alternatives, nothing booked, back to PROPOSED', async ({ task }) => {
    task.meta.expected = 'book() answers slot_taken — outcome slot_gone(slot_taken), no booking, state PROPOSED';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.scenario('BOOK_SLOT_TAKEN');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    expect(outcome).toMatchObject({ kind: 'slot_gone', reason: 'slot_taken' });
    expect(h.providerBookings()).toHaveLength(0);
    expect(stateOf(h)).toBe('PROPOSED');
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind}(${(outcome as { reason?: string }).reason}) bookings=${h.providerBookings().length} state=${stateOf(h)}`;
  });

  it('S13 repeated confirmation → one booking; a second approval on the same proposal is rejected', async ({ task }) => {
    task.meta.expected =
      'executing the same approval twice replays the stored outcome instead of booking again, and approving the (no longer pending) proposal a second time fails';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.scenario('BOOK_SUCCESS');

    const first = await h.engine.executor.execute(h.userId, approval.id);
    h.providerCalls().length = 0;
    const second = await h.engine.executor.execute(h.userId, approval.id);
    const reapprove = h.engine.approvals.approve(h.userId, {
      proposal_id: proposal.id,
      hash: proposal.hash,
      source: 'button',
    });

    expect(second).toEqual({ ...first, replayed: true });
    expect(h.providerCalls()).toHaveLength(0);
    expect(h.providerBookings()).toHaveLength(1);
    expect(reapprove).toMatchObject({ ok: false, reason: 'proposal_not_pending' });
    h.assertInvariants();

    task.meta.actual = `first=${first.kind} second=${second.kind}(replayed=${(second as { replayed?: boolean }).replayed}) bookings=${h.providerBookings().length} reapprove=${reapprove.ok}`;
  });

  it('S14 restart mid-booking → startup recovery resolves it, synced into the core booking row', async ({
    task,
  }) => {
    task.meta.expected =
      'the process dies after a book() that timed out without booking; on restart get_booking_status says not_booked, so recovery retries book ONCE with the SAME idempotency key and the approved hold (never a fresh approval) — exactly one booking, intent succeeded, state DONE, and a later Confirm replays the stored result';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    const key = idempotencyKey('book', approval.id);
    // The executor's claim: consume + `pending` intent in one transaction (plan §7/§8).
    h.engine.approvals.consume(h.userId, approval.id);
    createIntentsRepo(h.db).insertPending({
      idempotency_key: key,
      approval_id: approval.id,
      user_id: h.userId,
      action: 'book',
      created_at: h.clock.now().toISOString(),
      updated_at: h.clock.now().toISOString(),
    });
    h.engine.stateMachine.transition(h.userId, 'EXECUTING', 'executing book');

    // First attempt times out without booking; the process "crashes" before handling it.
    h.scenario('TIMEOUT_NOT_BOOKED');
    try {
      await h.client.book(h.userId, { hold_id: proposal.hold_id!, idempotency_key: key });
      expect.fail('expected a client-side timeout');
    } catch (err) {
      expect(ProviderError.isProviderError(err, 'timeout')).toBe(true);
    }

    const result = await resolvePendingIntents({
      db: h.db,
      clock: h.clock,
      providerClient: h.client,
      trace: h.trace,
      logger: h.logger,
    });

    const intent = createIntentsRepo(h.db).get(key);
    const bookKeys = h
      .providerCalls()
      .filter((c) => c.tool === 'book')
      .map((c) => (c.body as { idempotency_key: string }).idempotency_key);
    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });
    expect(bookKeys).toEqual([key, key]);
    expect(intent?.status).toBe('succeeded');
    expect(h.engine.bookings.list(h.userId)).toHaveLength(1);
    expect(h.providerBookings()).toHaveLength(1);
    expect(stateOf(h)).toBe('DONE');

    h.providerCalls().length = 0;
    const again = await h.engine.executor.execute(h.userId, approval.id);
    expect(again).toMatchObject({ kind: 'booked', replayed: true });
    expect(h.providerCalls()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `resolved=${result.resolved} succeeded=${result.succeeded} book_keys=${JSON.stringify(bookKeys)} intent=${intent?.status} bookings=${h.providerBookings().length} state=${stateOf(h)} reconfirm=${again.kind}`;
  });
});
