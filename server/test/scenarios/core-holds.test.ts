import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { idempotencyKey } from '../../src/core/intents/service.js';
import { createIntentsRepo } from '../../src/core/repo/index.js';
import { OTHER_USER } from '../core/helpers.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { findProvider, HOLD_TTL_MS, proposeBooking, stateOf } from './helpers.js';

/** Plan §16 "Hold / price matrix" — H1 through H10, all against a fresh `CoreHarness`. */
describe('core scenarios — hold / price matrix', () => {
  let h: CoreHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await createCoreHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('H1 hold price ≠ search price → card shows the hold price → booked at the hold price', async ({ task }) => {
    task.meta.expected =
      "the proposal's price and hash come from the hold's quoted price, never the search price; booking happens at that same price";

    h.scenario('PRICE_CHANGES_ON_HOLD');
    const proposal = await proposeBooking(h, provider);
    const hold = h.provider.engine.admin.state().holds.find((x) => x.hold_id === proposal.hold_id)!;

    expect(hold.price).not.toBe(provider.price);
    expect(proposal.price).toBe(hold.price);

    const approval = h.approve(proposal);
    h.scenario('BOOK_SUCCESS');
    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    expect(outcome).toMatchObject({ kind: 'booked', booking: { price: hold.price } });
    h.assertInvariants();

    task.meta.actual = `search_price=${provider.price} hold_price=${hold.price} proposal_price=${proposal.price} booked_price=${(outcome as { booking: { price: number } }).booking.price}`;
  });

  it('H2 approve → execute before expiry → booked, PROPOSED → APPROVED → EXECUTING → VERIFYING → DONE', async ({
    task,
  }) => {
    task.meta.expected = 'approving then executing before the hold expires books at the approved price and the trace shows every legal transition';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.scenario('BOOK_SUCCESS');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const path = h.trace.events.flatMap((e) => (e.type === 'state_transition' ? [e.to] : []));
    expect(outcome).toMatchObject({ kind: 'booked', booking: { price: proposal.price } });
    expect(path).toEqual(['PROPOSED', 'APPROVED', 'EXECUTING', 'VERIFYING', 'DONE']);
    expect(stateOf(h)).toBe('DONE');
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind} state=${stateOf(h)} path=${path.join('→')}`;
  });

  it('H3 hold expired → identical re-hold → proceeds without re-asking', async ({ task }) => {
    task.meta.expected =
      'the hold expires before execute; re-holding the identical slot recomputes the same hash, so execute proceeds and books without voiding the approval or raising a new card';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    h.scenario('BOOK_SUCCESS');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const voidEvents = h.trace.events.filter((e) => e.type === 'approval' && e.outcome === 'void');
    expect(outcome).toMatchObject({ kind: 'booked', booking: { price: proposal.price } });
    expect(h.providerCalls().map((c) => c.tool)).toEqual(['hold_slot', 'book']);
    expect(voidEvents).toEqual([]);
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind} calls=${h.providerCalls().map((c) => c.tool).join(',')} void_approval_events=${voidEvents.length}`;
  });

  it('H4 hold expired → re-hold price changed → void, re-approve, booked at the new price', async ({ task }) => {
    task.meta.expected =
      'the hold expires and the re-hold price differs from the original; the old approval is voided, a new proposal with the new price is pending, nothing is booked until it is approved';
    task.meta.notes =
      'drift direction (higher vs lower) is not selectable via the current provider admin API — PRICE_CHANGES_ON_HOLD only guarantees a changed price, not a direction. Seed 2 happens to drift higher for this call sequence; H5 uses seed 1, which drifts lower. See the Phase 2 wave 3a report for the gap.';

    await h.close();
    h = await createCoreHarness({ seed: 2 });
    provider = await findProvider(h);

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    h.scenario('PRICE_CHANGES_ON_HOLD');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);
    if (outcome.kind !== 'needs_reapproval') throw new Error(`unexpected ${outcome.kind}`);

    expect(outcome.previous_price).toBe(proposal.price);
    expect(outcome.new_price).not.toBe(proposal.price);
    expect(outcome.proposal.status).toBe('pending');
    const oldApproval = h.db.prepare('SELECT status, void_reason FROM approvals WHERE id = ?').get(approval.id) as {
      status: string;
      void_reason: string | null;
    };
    expect(oldApproval).toMatchObject({ status: 'void', void_reason: 'price_changed' });
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    const second = h.approve(outcome.proposal);
    h.scenario('BOOK_SUCCESS');
    const booked = await h.engine.executor.execute(h.userId, second.id);
    expect(booked).toMatchObject({ kind: 'booked', booking: { price: outcome.new_price } });
    h.assertInvariants();

    task.meta.actual = `previous=${outcome.previous_price} new=${outcome.new_price} direction=${outcome.new_price > outcome.previous_price ? 'higher' : 'lower'} old_approval=${oldApproval.status} re_approved_booked=${booked.kind}`;
  });

  it('H5 hold expired → re-hold price changed (observed lower) → void, re-approve, booked at the new price', async ({
    task,
  }) => {
    task.meta.expected =
      'same mechanics as H4: the re-hold price differs from the original (here, lower); old approval void, new proposal pending, nothing booked until re-approved';
    task.meta.notes =
      'drift direction is not forceable via the current admin API; seed 1 observed a lower price for this call sequence. See the Phase 2 wave 3a report.';

    await h.close();
    h = await createCoreHarness({ seed: 1 });
    provider = await findProvider(h);

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    h.scenario('PRICE_CHANGES_ON_HOLD');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);
    if (outcome.kind !== 'needs_reapproval') throw new Error(`unexpected ${outcome.kind}`);

    expect(outcome.previous_price).toBe(proposal.price);
    expect(outcome.new_price).not.toBe(proposal.price);
    expect(outcome.proposal.status).toBe('pending');
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    const second = h.approve(outcome.proposal);
    h.scenario('BOOK_SUCCESS');
    const booked = await h.engine.executor.execute(h.userId, second.id);
    expect(booked).toMatchObject({ kind: 'booked', booking: { price: outcome.new_price } });
    h.assertInvariants();

    task.meta.actual = `previous=${outcome.previous_price} new=${outcome.new_price} direction=${outcome.new_price > outcome.previous_price ? 'higher' : 'lower'} re_approved_booked=${booked.kind}`;
  });

  it('H6 hold expired and the slot was taken meanwhile → slot_gone(hold_expired), nothing booked', async ({
    task,
  }) => {
    task.meta.expected = 'the hold expires and someone else takes the slot before the re-hold; outcome slot_gone(hold_expired), approval void, no booking';

    const slot = provider.slots[0]!;
    const proposal = await proposeBooking(h, provider, slot);
    const approval = h.approve(proposal);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    // Simulate another user taking the now-open slot — a raw client call, not through this user's engine.
    await h.client.hold_slot(OTHER_USER, { provider_id: provider.id, slot });
    h.providerCalls().length = 0;

    const outcome = await h.engine.executor.execute(h.userId, approval.id);
    if (outcome.kind !== 'slot_gone') throw new Error(`unexpected ${outcome.kind}`);

    expect(outcome).toEqual({ kind: 'slot_gone', reason: 'hold_expired', alternatives: [] });
    expect(h.providerBookings()).toHaveLength(0);
    expect(stateOf(h)).toBe('PROPOSED');
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind}(${outcome.reason}) bookings=${h.providerBookings().length} state=${stateOf(h)}`;
  });

  it('H7 price changed → user declines → nothing booked, back to SEARCHING', async ({ task }) => {
    task.meta.expected = 'after needs_reapproval, declining the new card books nothing and leaves the errand at SEARCHING';

    const proposal = await proposeBooking(h, provider);
    const approval = h.approve(proposal);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    h.scenario('PRICE_CHANGES_ON_HOLD');
    const outcome = await h.engine.executor.execute(h.userId, approval.id);
    if (outcome.kind !== 'needs_reapproval') throw new Error(`unexpected ${outcome.kind}`);

    const declineResult = h.engine.proposals.decline(h.userId, outcome.proposal.id);

    expect(declineResult).toMatchObject({ ok: true, proposal: { status: 'declined' } });
    expect(h.providerBookings()).toHaveLength(0);
    expect(stateOf(h)).toBe('SEARCHING');
    h.assertInvariants();

    task.meta.actual = `decline_ok=${declineResult.ok} bookings=${h.providerBookings().length} state=${stateOf(h)}`;
  });

  it('H8 user idle past expiry then confirms → fresh hold + unchanged card, same mechanics as H3', async ({
    task,
  }) => {
    task.meta.expected =
      'the proposal sits unapproved past its hold expiry; listPending flags it expired, but approving it later still works and execute re-holds transparently';

    const proposal = await proposeBooking(h, provider);
    h.clock.advance(HOLD_TTL_MS + 60_000);
    const pending = h.engine.proposals.listPending(h.userId);
    expect(pending).toHaveLength(1);
    expect(pending[0]?.expired).toBe(true);

    const approval = h.approve(proposal);
    h.scenario('BOOK_SUCCESS');
    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    expect(outcome).toMatchObject({ kind: 'booked' });
    expect(h.providerCalls().map((c) => c.tool)).toEqual(['hold_slot', 'book']);
    h.assertInvariants();

    task.meta.actual = `pending_expired=${pending[0]?.expired} outcome=${outcome.kind} calls=${h.providerCalls().map((c) => c.tool).join(',')}`;
  });

  it('H9 a second proposal supersedes the first; approving the old card is rejected', async ({ task }) => {
    task.meta.expected = 'a new proposal supersedes any pending one for the same user; the superseded one can no longer be approved';

    const first = await proposeBooking(h, provider, provider.slots[0]!);
    const second = await proposeBooking(h, provider, provider.slots[1]!);

    const firstRow = h.db.prepare('SELECT status FROM proposals WHERE id = ?').get(first.id) as { status: string };
    const pendingIds = h.engine.proposals.listPending(h.userId).map((p) => p.id);
    const approveOld = h.engine.approvals.approve(h.userId, {
      proposal_id: first.id,
      hash: first.hash,
      source: 'button',
    });

    expect(firstRow.status).toBe('superseded');
    expect(pendingIds).toEqual([second.id]);
    expect(approveOld).toEqual({ ok: false, reason: 'proposal_not_pending' });
    h.assertInvariants();

    task.meta.actual = `first_status=${firstRow.status} pending=${JSON.stringify(pendingIds)} approve_old=${approveOld.ok}(${(approveOld as { reason?: string }).reason})`;
  });

  it('H10 book() returns hold_expired → one re-hold at the same price → booked, attempts = 2', async ({ task }) => {
    task.meta.expected = 'a hold_expired error from book() triggers exactly one re-hold; a second expiry would stop the attempt, but here the retry succeeds';

    const proposeResult = await h.engine.proposals.proposeBooking(h.userId, {
      provider_id: provider.id,
      provider_name: provider.name,
      service: provider.service,
      slot: provider.slots[0]!,
    });
    if (!proposeResult.ok) throw new Error(proposeResult.code);
    const approval = h.approve(proposeResult.proposal);
    const key = idempotencyKey('book', approval.id);
    h.scenario('HOLD_EXPIRED', 'BOOK_SUCCESS');

    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    const tools = h.providerCalls().map((c) => c.tool);
    const intent = createIntentsRepo(h.db).get(key);
    expect(outcome).toMatchObject({ kind: 'booked' });
    expect(tools).toEqual(['hold_slot', 'book', 'hold_slot', 'book']);
    expect(intent).toMatchObject({ status: 'succeeded', attempts: 2 });
    expect(h.providerBookings()).toHaveLength(1);
    h.assertInvariants();

    task.meta.actual = `outcome=${outcome.kind} calls=${tools.join(',')} intent_attempts=${intent?.attempts}`;
  });
});
