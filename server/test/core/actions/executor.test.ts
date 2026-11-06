import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { describeOutcome } from '../../../src/core/actions/outcomes.js';
import { idempotencyKey, type IntentService } from '../../../src/core/intents/service.js';
import {
  createApprovalsRepo,
  createBookingsRepo,
  createIntentsRepo,
  createProposalsRepo,
} from '../../../src/core/repo/index.js';
import type { IntentStatus } from '../../../src/core/types.js';
import { OTHER_USER, TEST_USER } from '../helpers.js';
import {
  approve,
  bookThroughExecutor,
  errorEvents,
  findProvider,
  proposeBooking,
  startEngineHarness,
  type EngineHarness,
} from '../engine-harness.js';

const HOLD_TTL_MS = 10 * 60_000;

describe('executor', () => {
  let h: EngineHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await startEngineHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  const repos = () => ({
    approvals: createApprovalsRepo(h.db),
    proposals: createProposalsRepo(h.db),
    intents: createIntentsRepo(h.db),
    bookings: createBookingsRepo(h.db),
  });

  /** Records the intent's status at the moment each mutating call leaves the server. */
  function watchIntentAtCall(key: string): (IntentStatus | undefined)[] {
    const seen: (IntentStatus | undefined)[] = [];
    h.onCall = (call) => {
      if (call.tool === 'book' || call.tool === 'cancel' || call.tool === 'reschedule') {
        seen.push(repos().intents.get(key)?.status);
      }
    };
    return seen;
  }

  describe('prologue — approval gate (invariant 1)', () => {
    it('a fabricated approval id is rejected with zero provider calls', async () => {
      await proposeBooking(h, provider);
      h.calls.length = 0;

      const outcome = await h.executor.execute(TEST_USER, 'appr_fabricated_by_model');

      expect(outcome).toEqual({ kind: 'rejected', reason: 'approval_not_valid' });
      expect(h.calls).toHaveLength(0);
      expect(h.providerBookings()).toHaveLength(0);
    });

    it('another user’s approval id is rejected with zero provider calls', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      h.calls.length = 0;

      expect(await h.executor.execute(OTHER_USER, approval.id)).toEqual({
        kind: 'rejected',
        reason: 'approval_not_valid',
      });
      expect(h.calls).toHaveLength(0);
    });

    it('a void approval or a tampered approval hash is rejected with zero provider calls', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      h.db.prepare('UPDATE approvals SET hash = ? WHERE id = ?').run('f'.repeat(64), approval.id);
      h.calls.length = 0;
      expect(await h.executor.execute(TEST_USER, approval.id)).toMatchObject({ reason: 'approval_not_valid' });

      h.approvals.void(TEST_USER, approval.id, 'test');
      expect(await h.executor.execute(TEST_USER, approval.id)).toMatchObject({ reason: 'approval_not_valid' });
      expect(h.calls).toHaveLength(0);
    });
  });

  describe('book', () => {
    it('approve → execute before expiry → booked; intent written before the provider call; legal transitions', async () => {
      const proposal = await proposeBooking(h, provider);
      const approval = approve(h, proposal);
      const key = idempotencyKey('book', approval.id);
      const seen = watchIntentAtCall(key);
      h.scenario('BOOK_SUCCESS');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'booked', replayed: false, booking: { price: proposal.price } });
      expect(seen).toEqual(['pending']);
      expect(h.calls.map((c) => c.tool)).toEqual(['book']);
      expect(h.calls[0]!.body).toEqual({ hold_id: proposal.hold_id, idempotency_key: key });
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(repos().approvals.get(TEST_USER, approval.id)?.status).toBe('consumed');
      expect(repos().bookings.list(TEST_USER)).toHaveLength(1);
      expect(h.providerBookings()).toHaveLength(1);
      expect(h.state()).toBe('DONE');
      expect(errorEvents(h)).toEqual([]);
      const path = h.trace.events.flatMap((e) => (e.type === 'state_transition' ? [e.to] : []));
      expect(path).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'VERIFYING', 'DONE']);
      expect(h.trace.events.find((e) => e.type === 'tool_call' && e.tool === 'book')).toMatchObject({ ok: true });
    });

    it('a second execute after success is a replay — one provider booking, no second book call', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      h.scenario('BOOK_SUCCESS');
      const first = await h.executor.execute(TEST_USER, approval.id);
      h.calls.length = 0;

      const second = await h.executor.execute(TEST_USER, approval.id);

      expect(second).toEqual({ ...first, replayed: true });
      expect(h.calls).toHaveLength(0);
      expect(h.providerBookings()).toHaveLength(1);
      expect(describeOutcome(second)).toMatch(/already done/);
    });

    it('two concurrent executes of one approval → one booking, the other rejected', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      h.scenario('BOOK_SUCCESS');

      const outcomes = await Promise.all([
        h.executor.execute(TEST_USER, approval.id),
        h.executor.execute(TEST_USER, approval.id),
      ]);

      expect(outcomes.map((o) => o.kind).sort()).toEqual(['booked', 'rejected']);
      expect(outcomes.find((o) => o.kind === 'rejected')).toMatchObject({ reason: 'approval_already_consumed' });
      expect(h.calls.filter((c) => c.tool === 'book')).toHaveLength(1);
      expect(h.providerBookings()).toHaveLength(1);
    });

    it('hold expired → identical re-hold → proceeds without re-asking', async () => {
      const proposal = await proposeBooking(h, provider);
      const approval = approve(h, proposal);
      h.tp.clock.advance(HOLD_TTL_MS + 60_000);
      h.scenario('BOOK_SUCCESS');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'booked', booking: { price: proposal.price } });
      expect(h.calls.map((c) => c.tool)).toEqual(['hold_slot', 'book']);
      const stored = repos().proposals.get(TEST_USER, proposal.id)!;
      expect(stored.hold_id).not.toBe(proposal.hold_id);
      expect(stored.hash).toBe(proposal.hash);
      expect(h.providerBookings()).toHaveLength(1);
      expect(errorEvents(h)).toEqual([]);
    });

    it('hold expired + price changes on re-hold → needs_reapproval, old approval void, zero bookings', async () => {
      const proposal = await proposeBooking(h, provider);
      const approval = approve(h, proposal);
      h.tp.clock.advance(HOLD_TTL_MS + 60_000);
      h.scenario('PRICE_CHANGES_ON_HOLD');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      if (outcome.kind !== 'needs_reapproval') throw new Error(`unexpected ${outcome.kind}`);
      expect(outcome.previous_price).toBe(proposal.price);
      expect(outcome.new_price).not.toBe(proposal.price);
      expect(outcome.proposal).toMatchObject({ status: 'pending', price: outcome.new_price });
      expect(outcome.proposal.hash).not.toBe(proposal.hash);
      expect(repos().approvals.get(TEST_USER, approval.id)).toMatchObject({ status: 'void', void_reason: 'price_changed' });
      expect(repos().proposals.get(TEST_USER, proposal.id)?.status).toBe('superseded');
      expect(repos().intents.get(idempotencyKey('book', approval.id))).toBeUndefined();
      expect(h.calls.map((c) => c.tool)).toEqual(['hold_slot']);
      expect(h.providerBookings()).toHaveLength(0);
      expect(h.state()).toBe('PROPOSED');
      expect(describeOutcome(outcome)).toContain(`₹${outcome.new_price}`);

      // The user confirms the new card → booked at the new hold price.
      const second = approve(h, outcome.proposal);
      h.scenario('BOOK_SUCCESS');
      expect(await h.executor.execute(TEST_USER, second.id)).toMatchObject({
        kind: 'booked',
        booking: { price: outcome.new_price },
      });
      expect(h.providerBookings()).toHaveLength(1);
      expect(errorEvents(h)).toEqual([]);
    });

    it('hold expired and the slot was taken meanwhile → slot_gone(hold_expired), approval void, nothing booked', async () => {
      const slot = provider.slots[0]!;
      const proposal = await proposeBooking(h, provider, slot);
      const approval = approve(h, proposal);
      h.tp.clock.advance(HOLD_TTL_MS + 60_000);
      await h.providerClient.hold_slot(OTHER_USER, { provider_id: provider.id, slot });
      h.calls.length = 0;

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toEqual({ kind: 'slot_gone', reason: 'hold_expired', alternatives: [] });
      expect(repos().approvals.get(TEST_USER, approval.id)?.status).toBe('void');
      expect(repos().proposals.get(TEST_USER, proposal.id)?.status).toBe('expired');
      expect(h.calls.map((c) => c.tool)).toEqual(['hold_slot']);
      expect(h.providerBookings()).toHaveLength(0);
      expect(h.state()).toBe('PROPOSED');
    });

    it('book returns hold_expired → one re-hold at the same price → booked, attempts = 2', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      const key = idempotencyKey('book', approval.id);
      h.scenario('HOLD_EXPIRED', 'BOOK_SUCCESS');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'booked' });
      expect(h.calls.map((c) => c.tool)).toEqual(['book', 'hold_slot', 'book']);
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(h.providerBookings()).toHaveLength(1);
      expect(errorEvents(h)).toEqual([]);
    });

    it('slot_taken on book → slot_gone, intent failed, nothing booked', async () => {
      const proposal = await proposeBooking(h, provider);
      const approval = approve(h, proposal);
      const key = idempotencyKey('book', approval.id);
      const seen = watchIntentAtCall(key);
      h.scenario('BOOK_SLOT_TAKEN');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'slot_gone', reason: 'slot_taken' });
      expect(seen).toEqual(['pending']);
      expect(repos().intents.get(key)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(repos().proposals.get(TEST_USER, proposal.id)?.status).toBe('expired');
      expect(h.providerBookings()).toHaveLength(0);
      expect(h.state()).toBe('PROPOSED');
      expect(errorEvents(h)).toEqual([]);
    });

    it('timeout after the provider booked → verified via get_booking_status, exactly one booking', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      const key = idempotencyKey('book', approval.id);
      h.scenario('TIMEOUT_BOOKED');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'booked', replayed: false });
      expect(h.calls.map((c) => c.tool)).toEqual(['book', 'get_booking_status']);
      expect(h.calls[1]!.body).toEqual({ idempotency_key: key });
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(h.providerBookings()).toHaveLength(1);
      expect(h.state()).toBe('DONE');
      expect(h.trace.events.find((e) => e.type === 'tool_call' && e.tool === 'book')).toMatchObject({ ok: false });
      expect(errorEvents(h)).toEqual([]);
    });

    it('timeout not booked → retry with the same key → booked, one booking, attempts = 2', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      const key = idempotencyKey('book', approval.id);
      h.scenario('TIMEOUT_NOT_BOOKED', 'BOOK_SUCCESS');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'booked' });
      expect(h.calls.map((c) => c.tool)).toEqual(['book', 'get_booking_status', 'book']);
      const bookKeys = h.calls.filter((c) => c.tool === 'book').map((c) => (c.body as { idempotency_key: string }).idempotency_key);
      expect(bookKeys).toEqual([key, key]);
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(h.providerBookings()).toHaveLength(1);
    });

    it('timeouts never resolve → unconfirmed, intent unknown, the message never claims success', async () => {
      const approval = approve(h, await proposeBooking(h, provider));
      const key = idempotencyKey('book', approval.id);
      h.scenario('TIMEOUT_NOT_BOOKED', 'TIMEOUT_NOT_BOOKED', 'TIMEOUT_NOT_BOOKED');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toEqual({ kind: 'unconfirmed', idempotency_key: key, checks: 3 });
      expect(repos().intents.get(key)).toMatchObject({ status: 'unknown', attempts: 3 });
      expect(h.calls.filter((c) => c.tool === 'get_booking_status')).toHaveLength(3);
      expect(h.providerBookings()).toHaveLength(0);
      expect(h.state()).toBe('VERIFYING');
      const text = describeOutcome(outcome);
      expect(text).toMatch(/unconfirmed/);
      expect(text).not.toMatch(/\bbooked\b|\bconfirmed\b|\bdone\b/i);
      expect(errorEvents(h)).toEqual([]);

      // The consumed approval can't start a second attempt.
      expect(await h.executor.execute(TEST_USER, approval.id)).toEqual({
        kind: 'rejected',
        reason: 'approval_already_consumed',
      });
    });
  });

  describe('crash safety', () => {
    /** The first `intents.fail` is recorded, then the process "crashes" before anything after it runs. */
    function crashAfterFirstFail(intents: IntentService): IntentService {
      let crashed = false;
      return {
        ...intents,
        fail: (...args) => {
          const intent = intents.fail(...args);
          if (crashed) return intent;
          crashed = true;
          throw new Error('simulated crash after intent failed');
        },
      };
    }

    it('intents.begin throws → consume rolled back, approval still valid, a second execute books once', async () => {
      await h.close();
      let crashed = false;
      h = await startEngineHarness({
        wrapIntents: (intents) => ({
          ...intents,
          begin: (...args) => {
            if (!crashed) {
              crashed = true;
              throw new Error('simulated crash between consume and intent');
            }
            return intents.begin(...args);
          },
        }),
      });
      provider = await findProvider(h);
      const approval = approve(h, await proposeBooking(h, provider));
      const key = idempotencyKey('book', approval.id);

      const first = await h.executor.execute(TEST_USER, approval.id);

      expect(first).toMatchObject({ kind: 'failed', code: 'internal' });
      expect(repos().approvals.get(TEST_USER, approval.id)?.status).toBe('valid');
      expect(repos().intents.get(key)).toBeUndefined();
      expect(h.calls).toHaveLength(0);
      expect(h.state()).toBe('APPROVED');
      // The rolled-back claim must leave no trace record claiming it happened.
      expect(h.trace.events.filter((e) => e.type === 'approval' && e.outcome === 'consumed')).toHaveLength(0);
      expect(h.trace.events.filter((e) => e.type === 'intent' && e.idempotency_key === key)).toHaveLength(0);

      h.scenario('BOOK_SUCCESS');
      const second = await h.executor.execute(TEST_USER, approval.id);

      expect(second).toMatchObject({ kind: 'booked', replayed: false });
      expect(repos().approvals.get(TEST_USER, approval.id)?.status).toBe('consumed');
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 1 });
      expect(h.providerBookings()).toHaveLength(1);
      expect(h.state()).toBe('DONE');
    });

    it('unexpected failure after the approval is spent → failed outcome and task state FAILED, not stuck', async () => {
      await h.close();
      h = await startEngineHarness({ wrapIntents: crashAfterFirstFail });
      provider = await findProvider(h);
      const approval = approve(h, await proposeBooking(h, provider));
      h.scenario('BOOK_SLOT_TAKEN');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'failed', code: 'internal' });
      expect(repos().intents.get(idempotencyKey('book', approval.id))?.status).toBe('failed');
      expect(repos().approvals.get(TEST_USER, approval.id)?.status).toBe('consumed');
      expect(h.state()).toBe('FAILED');
      expect(h.providerBookings()).toHaveLength(0);
    });
  });

  describe('cancel', () => {
    it('CANCEL_503_ONCE → retried with the same key → cancelled, attempts = 2', async () => {
      const bookingId = await bookThroughExecutor(h, provider);
      const result = await h.proposals.proposeCancel(TEST_USER, { booking_id: bookingId });
      if (!result.ok) throw new Error(result.code);
      const approval = approve(h, result.proposal);
      const key = idempotencyKey('cancel', approval.id);
      const seen = watchIntentAtCall(key);
      h.scenario('CANCEL_503_ONCE');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'cancelled', booking: { booking_id: bookingId, status: 'cancelled' } });
      expect(seen).toEqual(['pending', 'pending']);
      expect(h.calls.map((c) => (c.body as { idempotency_key?: string }).idempotency_key)).toEqual([key, key]);
      expect(repos().intents.get(key)).toMatchObject({ status: 'succeeded', attempts: 2 });
      expect(repos().bookings.get(TEST_USER, bookingId)?.status).toBe('cancelled');
      expect(h.providerBookings()[0]?.status).toBe('cancelled');
      expect(h.state()).toBe('DONE');
      expect(errorEvents(h)).toEqual([]);
    });

    it('booking already cancelled by the provider counts as cancelled', async () => {
      const bookingId = await bookThroughExecutor(h, provider);
      const result = await h.proposals.proposeCancel(TEST_USER, { booking_id: bookingId });
      if (!result.ok) throw new Error(result.code);
      const approval = approve(h, result.proposal);
      h.tp.engine.admin.cancelBookingByProvider(bookingId);

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'cancelled', booking: { booking_id: bookingId, status: 'cancelled' } });
      expect(repos().bookings.get(TEST_USER, bookingId)?.status).toBe('cancelled');
    });
  });

  describe('cancel with no retries left', () => {
    it('503 with retriesPerTool = 0 → failed, intent failed, FAILED state', async () => {
      await h.close();
      h = await startEngineHarness({ limits: { statusChecks: 3, retriesPerTool: 0 } });
      provider = await findProvider(h);
      const bookingId = await bookThroughExecutor(h, provider);
      const result = await h.proposals.proposeCancel(TEST_USER, { booking_id: bookingId });
      if (!result.ok) throw new Error(result.code);
      const approval = approve(h, result.proposal);
      h.scenario('CANCEL_503_ONCE');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({ kind: 'failed', code: 'transient' });
      expect(repos().intents.get(idempotencyKey('cancel', approval.id))).toMatchObject({ status: 'failed', attempts: 1 });
      expect(h.providerBookings()[0]?.status).toBe('confirmed');
      expect(h.state()).toBe('FAILED');
    });
  });

  describe('reschedule', () => {
    it('RESCHEDULE_CONFLICT → slot_gone with alternatives, intent failed, back to PROPOSED', async () => {
      const bookingId = await bookThroughExecutor(h, provider);
      const result = await h.proposals.proposeReschedule(TEST_USER, { booking_id: bookingId, slot: provider.slots[1]! });
      if (!result.ok) throw new Error(result.code);
      const approval = approve(h, result.proposal);
      const key = idempotencyKey('reschedule', approval.id);
      h.scenario('RESCHEDULE_CONFLICT');

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      if (outcome.kind !== 'slot_gone') throw new Error(`unexpected ${outcome.kind}`);
      expect(outcome.reason).toBe('slot_conflict');
      expect(outcome.alternatives.length).toBeGreaterThan(0);
      expect(repos().intents.get(key)).toMatchObject({ status: 'failed', attempts: 1 });
      expect(repos().proposals.get(TEST_USER, result.proposal.id)?.status).toBe('expired');
      expect(h.providerBookings()[0]?.slot).toEqual(provider.slots[0]);
      expect(h.state()).toBe('PROPOSED');
      expect(errorEvents(h)).toEqual([]);
    });

    it('success → rescheduled with the previous slot; app booking moved', async () => {
      const bookingId = await bookThroughExecutor(h, provider);
      const newSlot = provider.slots[2]!;
      const result = await h.proposals.proposeReschedule(TEST_USER, { booking_id: bookingId, slot: newSlot });
      if (!result.ok) throw new Error(result.code);
      const approval = approve(h, result.proposal);

      const outcome = await h.executor.execute(TEST_USER, approval.id);

      expect(outcome).toMatchObject({
        kind: 'rescheduled',
        previous_slot: provider.slots[0],
        booking: { booking_id: bookingId, slot: newSlot, status: 'rescheduled' },
      });
      expect(repos().bookings.get(TEST_USER, bookingId)?.slot).toEqual(newSlot);
      expect(h.state()).toBe('DONE');
      expect(errorEvents(h)).toEqual([]);
    });
  });
});
