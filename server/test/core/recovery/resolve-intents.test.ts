import { afterEach, describe, expect, it } from 'vitest';
import type { Hold } from '@bellhop/shared/contracts';
import { createProviderAdminClient } from '../../../src/provider-client/admin.js';
import { ProviderError } from '../../../src/provider-client/errors.js';
import {
  createApprovalsRepo,
  createBookingsRepo,
  createIntentsRepo,
  createProposalsRepo,
} from '../../../src/core/repo/index.js';
import { resolvePendingIntents } from '../../../src/core/recovery/resolve-intents.js';
import type { Action, TaskStateName } from '../../../src/core/types.js';
import { createCoreHarness, type CoreHarness } from '../../helpers/core-harness.js';
import { makeApproval, makeProposal } from '../fixtures.js';

const HOLD_TTL_MS = 10 * 60_000;

/** Seeds a proposal + consumed approval, as the executor leaves them right after its claim transaction. */
function seedApprovedProposal(harness: CoreHarness, overrides: Parameters<typeof makeProposal>[0] = {}) {
  const proposal = makeProposal({ user_id: harness.userId, status: 'approved', ...overrides });
  createProposalsRepo(harness.db).insert(proposal);
  const approval = makeApproval({
    proposal_id: proposal.id,
    user_id: harness.userId,
    hash: proposal.hash,
    status: 'consumed',
    consumed_at: harness.clock.now().toISOString(),
  });
  createApprovalsRepo(harness.db).insert(approval);
  return { proposal, approval };
}

function seedPendingIntent(harness: CoreHarness, key: string, approvalId: string, action: Action = 'book') {
  const now = harness.clock.now().toISOString();
  createIntentsRepo(harness.db).insertPending({
    idempotency_key: key,
    approval_id: approvalId,
    user_id: harness.userId,
    action,
    created_at: now,
    updated_at: now,
  });
}

/** Seeds a book proposal over a real provider hold, with its pending intent. */
function seedBookIntent(harness: CoreHarness, hold: Hold, key: string) {
  const { proposal, approval } = seedApprovedProposal(harness, {
    provider_id: hold.provider_id,
    slot: hold.slot,
    price: hold.price,
    hold_id: hold.hold_id,
    hold_expires_at: hold.expires_at,
  });
  seedPendingIntent(harness, key, approval.id);
  return proposal;
}

/** Drives the task state the way the executor would have before the "crash". */
function driveTo(harness: CoreHarness, path: TaskStateName[]) {
  for (const to of path) harness.engine.stateMachine.transition(harness.userId, to, 'test setup');
}

const IN_FLIGHT: TaskStateName[] = ['PROPOSED', 'APPROVED', 'EXECUTING'];

async function holdFirstSlot(harness: CoreHarness): Promise<Hold> {
  const from = harness.clock.now().toISOString();
  const to = new Date(harness.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await harness.client.search_providers(harness.userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = providers[0]!;
  const { hold } = await harness.client.hold_slot(harness.userId, { provider_id: provider.id, slot: provider.slots[0]! });
  harness.providerCalls().length = 0;
  return hold;
}

function recover(harness: CoreHarness) {
  return resolvePendingIntents({
    db: harness.db,
    clock: harness.clock,
    providerClient: harness.client,
    trace: harness.trace,
    logger: harness.logger,
  });
}

function stateOf(harness: CoreHarness): TaskStateName {
  return harness.engine.taskState.get(harness.userId)?.state ?? 'GATHERING';
}

function countRows(harness: CoreHarness, table: 'approvals' | 'proposals'): number {
  return (harness.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe('resolvePendingIntents (plan §8 startup recovery)', () => {
  let harness: CoreHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = undefined;
  });

  it('book() timed out but the provider booked → succeeded from get_booking_status, synced, DONE', async () => {
    harness = await createCoreHarness();
    const admin = createProviderAdminClient({ baseUrl: harness.provider.url });
    const hold = await holdFirstSlot(harness);
    const key = 'book_restart_1';

    await admin.scenario({ outcomes: ['TIMEOUT_BOOKED'] });
    try {
      await harness.client.book(harness.userId, { hold_id: hold.hold_id, idempotency_key: key });
      expect.fail('expected ProviderError timeout');
    } catch (err) {
      expect(ProviderError.isProviderError(err, 'timeout')).toBe(true);
    }
    seedBookIntent(harness, hold, key);
    driveTo(harness, IN_FLIGHT);
    harness.providerCalls().length = 0;

    const result = await recover(harness);

    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });
    expect(harness.providerCalls().map((c) => c.tool)).toEqual(['get_booking_status']);
    const intent = createIntentsRepo(harness.db).get(key);
    expect(intent?.status).toBe('succeeded');
    expect(intent?.result).toMatchObject({ kind: 'booked', booking: { status: 'confirmed', user_id: harness.userId } });
    expect(createBookingsRepo(harness.db).list(harness.userId)).toEqual([
      expect.objectContaining({ status: 'confirmed', user_id: harness.userId }),
    ]);
    expect(stateOf(harness)).toBe('DONE');
    expect(harness.trace.events.filter((e) => e.type === 'intent')).toEqual([
      { type: 'intent', idempotency_key: key, action: 'book', status: 'succeeded' },
    ]);
    expect(harness.trace.events.find((e) => e.type === 'tool_call')).toMatchObject({ tool: 'get_booking_status' });
  });

  it('not booked → ONE retry with the same key and the approved hold → succeeded, one booking, no re-approval', async () => {
    harness = await createCoreHarness();
    const hold = await holdFirstSlot(harness);
    const key = 'book_crashed_before_call';
    seedBookIntent(harness, hold, key);
    driveTo(harness, IN_FLIGHT);
    const approvalsBefore = countRows(harness, 'approvals');
    const proposalsBefore = countRows(harness, 'proposals');

    const result = await recover(harness);

    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });
    const calls = harness.providerCalls();
    expect(calls.map((c) => c.tool)).toEqual(['get_booking_status', 'book']);
    expect(calls[1]!.body).toEqual({ hold_id: hold.hold_id, idempotency_key: key });
    expect(createIntentsRepo(harness.db).get(key)).toMatchObject({ status: 'succeeded', attempts: 1 });
    expect(createBookingsRepo(harness.db).list(harness.userId)).toHaveLength(1);
    expect(harness.providerBookings()).toHaveLength(1);
    expect(stateOf(harness)).toBe('DONE');
    expect(countRows(harness, 'approvals')).toBe(approvalsBefore);
    expect(countRows(harness, 'proposals')).toBe(proposalsBefore);
    harness.assertInvariants();
  });

  it('not booked and the hold expired → the one retry answers hold_expired → failed, FAILED, nothing booked', async () => {
    harness = await createCoreHarness();
    const hold = await holdFirstSlot(harness);
    const key = 'book_hold_gone';
    seedBookIntent(harness, hold, key);
    driveTo(harness, IN_FLIGHT);
    harness.clock.advance(HOLD_TTL_MS + 60_000);

    const result = await recover(harness);

    expect(result).toEqual({ resolved: 1, succeeded: 0, failed: 1, stillUnknown: 0 });
    expect(harness.providerCalls().map((c) => c.tool)).toEqual(['get_booking_status', 'book']);
    expect(createIntentsRepo(harness.db).get(key)).toMatchObject({
      status: 'failed',
      result: { kind: 'failed', code: 'hold_expired' },
    });
    expect(harness.providerBookings()).toHaveLength(0);
    expect(stateOf(harness)).toBe('FAILED');
  });

  it('not booked and the retry times out again → left unknown, never failed, state untouched', async () => {
    harness = await createCoreHarness();
    const hold = await holdFirstSlot(harness);
    const key = 'book_retry_times_out';
    seedBookIntent(harness, hold, key);
    driveTo(harness, IN_FLIGHT);
    harness.scenario('TIMEOUT_NOT_BOOKED');

    const result = await recover(harness);

    expect(result).toEqual({ resolved: 0, succeeded: 0, failed: 0, stillUnknown: 1 });
    expect(harness.providerCalls().map((c) => c.tool)).toEqual(['get_booking_status', 'book']);
    expect(createIntentsRepo(harness.db).get(key)?.status).toBe('unknown');
    expect(stateOf(harness)).toBe('EXECUTING');
  });

  it('a task that has moved on keeps its state; only the intent is resolved', async () => {
    harness = await createCoreHarness();
    const hold = await holdFirstSlot(harness);
    const key = 'book_after_new_errand';
    seedBookIntent(harness, hold, key);
    driveTo(harness, ['PROPOSED']);

    const result = await recover(harness);

    expect(result.succeeded).toBe(1);
    expect(stateOf(harness)).toBe('PROPOSED');
  });

  it('provider down (closed server) leaves the intent unknown and never throws', async () => {
    harness = await createCoreHarness();
    const { approval } = seedApprovedProposal(harness);
    const key = 'book_provider_down';
    seedPendingIntent(harness, key, approval.id);

    await harness.provider.close();
    const result = await recover(harness);

    expect(result).toEqual({ resolved: 0, succeeded: 0, failed: 0, stillUnknown: 1 });
    expect(createIntentsRepo(harness.db).get(key)?.status).toBe('unknown');

    // Provider is already closed; only the db needs cleanup here.
    harness.db.close();
    harness = undefined;
  });

  it('cancel intent → straight to list_bookings (no get_booking_status), succeeded when actually cancelled', async () => {
    harness = await createCoreHarness();
    const admin = createProviderAdminClient({ baseUrl: harness.provider.url });
    const hold = await holdFirstSlot(harness);
    const bookOut = await harness.client.book(harness.userId, {
      hold_id: hold.hold_id,
      idempotency_key: 'book_for_cancel_recovery',
    });
    // Cancel's default first attempt is a transient 503 unless forced; this test is about recovery, not cancel's retry.
    await admin.scenario({ outcomes: ['CANCEL_OK'] });
    await harness.client.cancel(harness.userId, {
      booking_id: bookOut.booking.booking_id,
      idempotency_key: 'cancel_recovery_1',
    });

    const { approval } = seedApprovedProposal(harness, { action: 'cancel', booking_id: bookOut.booking.booking_id });
    seedPendingIntent(harness, 'cancel_recovery_1', approval.id, 'cancel');
    harness.providerCalls().length = 0;

    const result = await recover(harness);

    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });
    expect(harness.providerCalls().map((c) => c.tool)).toEqual(['list_bookings']);
    expect(createIntentsRepo(harness.db).get('cancel_recovery_1')).toMatchObject({
      status: 'succeeded',
      result: { kind: 'cancelled', booking: { user_id: harness.userId } },
    });
    expect(createBookingsRepo(harness.db).get(harness.userId, bookOut.booking.booking_id)?.status).toBe('cancelled');
  });
});
