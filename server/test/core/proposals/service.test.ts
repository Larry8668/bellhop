import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { proposalHash } from '../../../src/core/approvals/hash.js';
import { createBookingsRepo, createProposalsRepo } from '../../../src/core/repo/index.js';
import { OTHER_USER, TEST_USER } from '../helpers.js';
import {
  approve,
  bookThroughExecutor,
  findProvider,
  proposeBooking,
  startEngineHarness,
  type EngineHarness,
} from '../engine-harness.js';

describe('proposal service', () => {
  let h: EngineHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await startEngineHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('hash and price come from the hold, not the search price', async () => {
    h.scenario('PRICE_CHANGES_ON_HOLD');
    const proposal = await proposeBooking(h, provider);
    const hold = h.tp.engine.admin.state().holds.find((x) => x.hold_id === proposal.hold_id)!;

    expect(hold.price).not.toBe(provider.price);
    expect(proposal.price).toBe(hold.price);
    expect(proposal.hash).toBe(
      proposalHash({ action: 'book', provider_id: provider.id, slot: proposal.slot, price: hold.price, booking_id: null }),
    );
    expect(proposal).toMatchObject({ status: 'pending', hold_expires_at: hold.expires_at });
    expect(h.state()).toBe('PROPOSED');

    const holdCall = h.trace.events.find((e) => e.type === 'tool_call');
    expect(holdCall).toMatchObject({ type: 'tool_call', tool: 'hold_slot', ok: true });
  });

  it('a second proposal supersedes the first; approving the old card is rejected', async () => {
    const first = await proposeBooking(h, provider, provider.slots[0]);
    const second = await proposeBooking(h, provider, provider.slots[1]);
    const repo = createProposalsRepo(h.db);

    expect(repo.get(TEST_USER, first.id)?.status).toBe('superseded');
    expect(repo.listPending(TEST_USER).map((p) => p.id)).toEqual([second.id]);

    const result = h.approvals.approve(TEST_USER, { proposal_id: first.id, hash: first.hash, source: 'button' });
    expect(result).toEqual({ ok: false, reason: 'proposal_not_pending' });
  });

  it('maps a provider error to { ok: false } instead of throwing', async () => {
    const result = await h.proposals.proposeBooking(TEST_USER, {
      provider_id: provider.id,
      provider_name: provider.name,
      service: provider.service,
      slot: { start: '2030-01-01T00:00:00+05:30', end: '2030-01-01T01:00:00+05:30' },
    });
    expect(result).toMatchObject({ ok: false, code: 'slot_unavailable' });
    expect(h.state()).toBe('GATHERING');
    expect(h.trace.events.find((e) => e.type === 'tool_call')).toMatchObject({ tool: 'hold_slot', ok: false });
  });

  it('rejects invalid input without calling the provider', async () => {
    const result = await h.proposals.proposeBooking(TEST_USER, {
      provider_id: '',
      provider_name: 'x',
      service: 'plumber',
      slot: provider.slots[0]!,
    });
    expect(result).toMatchObject({ ok: false, code: 'bad_request' });
    expect(h.calls).toHaveLength(0);
  });

  it('refuses to propose from a state that cannot reach PROPOSED, before holding anything', async () => {
    await bookThroughExecutor(h, provider);
    h.stateMachine.transition(TEST_USER, 'SEARCHING');
    const result = await h.proposals.proposeBooking(TEST_USER, {
      provider_id: provider.id,
      provider_name: provider.name,
      service: provider.service,
      slot: provider.slots[1]!,
    });
    expect(result).toMatchObject({ ok: false, code: 'invalid_state' });
    expect(h.calls).toHaveLength(0);
  });

  it('proposeCancel falls back to list_bookings, syncs the booking, and hashes over booking_id', async () => {
    const bookingId = await bookThroughExecutor(h, provider);
    const bookingsRepo = createBookingsRepo(h.db);
    h.db.prepare('DELETE FROM bookings').run();

    const result = await h.proposals.proposeCancel(TEST_USER, { booking_id: bookingId });
    if (!result.ok) throw new Error(result.code);

    expect(h.calls.map((c) => c.tool)).toEqual(['list_bookings']);
    expect(bookingsRepo.get(TEST_USER, bookingId)?.status).toBe('confirmed');
    expect(result.proposal).toMatchObject({ action: 'cancel', booking_id: bookingId, hold_id: null, slot: provider.slots[0] });
    expect(result.proposal.hash).toBe(
      proposalHash({
        action: 'cancel',
        provider_id: provider.id,
        slot: provider.slots[0]!,
        price: result.proposal.price,
        booking_id: bookingId,
      }),
    );
    expect(h.state()).toBe('PROPOSED');
  });

  it('proposeCancel for an unknown or other-user booking → booking_not_found', async () => {
    const bookingId = await bookThroughExecutor(h, provider);
    expect(await h.proposals.proposeCancel(TEST_USER, { booking_id: 'bk_nope' })).toMatchObject({
      ok: false,
      code: 'booking_not_found',
    });
    expect(await h.proposals.proposeCancel(OTHER_USER, { booking_id: bookingId })).toMatchObject({
      ok: false,
      code: 'booking_not_found',
    });
  });

  it('proposeReschedule hashes over the NEW slot + booking_id at the booking price', async () => {
    const bookingId = await bookThroughExecutor(h, provider);
    const newSlot = provider.slots[2]!;
    const result = await h.proposals.proposeReschedule(TEST_USER, { booking_id: bookingId, slot: newSlot });
    if (!result.ok) throw new Error(result.code);

    expect(result.proposal).toMatchObject({ action: 'reschedule', slot: newSlot, booking_id: bookingId });
    expect(result.proposal.hash).toBe(
      proposalHash({
        action: 'reschedule',
        provider_id: provider.id,
        slot: newSlot,
        price: result.proposal.price,
        booking_id: bookingId,
      }),
    );
    expect(h.calls).toHaveLength(0);
  });

  it('decline marks the proposal declined and goes back to SEARCHING', async () => {
    const proposal = await proposeBooking(h, provider);
    const result = h.proposals.decline(TEST_USER, proposal.id);

    expect(result).toMatchObject({ ok: true, proposal: { status: 'declined' } });
    expect(h.state()).toBe('SEARCHING');
    expect(h.proposals.decline(TEST_USER, proposal.id)).toMatchObject({ ok: false, code: 'proposal_not_pending' });
    expect(h.proposals.decline(OTHER_USER, proposal.id)).toMatchObject({ ok: false, code: 'proposal_not_found' });
  });

  it('listPending flags a pending proposal whose hold has expired', async () => {
    await proposeBooking(h, provider);
    expect(h.proposals.listPending(TEST_USER).map((p) => p.expired)).toEqual([false]);
    h.tp.clock.advance(11 * 60_000);
    expect(h.proposals.listPending(TEST_USER).map((p) => p.expired)).toEqual([true]);
  });

  it('a proposal approved by its owner is invisible to another user', async () => {
    const proposal = await proposeBooking(h, provider);
    approve(h, proposal);
    expect(h.proposals.listPending(OTHER_USER)).toEqual([]);
  });
});
