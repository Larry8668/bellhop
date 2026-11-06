import { afterEach, describe, expect, it } from 'vitest';
import { createProviderAdminClient } from '../../../src/provider-client/admin.js';
import { ProviderError } from '../../../src/provider-client/errors.js';
import { createApprovalsRepo } from '../../../src/core/repo/approvals.repo.js';
import { createBookingsRepo } from '../../../src/core/repo/bookings.repo.js';
import { createIntentsRepo } from '../../../src/core/repo/intents.repo.js';
import { createProposalsRepo } from '../../../src/core/repo/proposals.repo.js';
import { resolvePendingIntents } from '../../../src/core/recovery/resolve-intents.js';
import { createCoreHarness, type CoreHarness } from '../../helpers/core-harness.js';
import { makeApproval, makeProposal } from '../fixtures.js';

/** Seeds a `pending` proposal + `valid` approval so `intents.approval_id` satisfies its FK, and returns both. */
function seedApprovedProposal(harness: CoreHarness, overrides: Parameters<typeof makeProposal>[0] = {}) {
  const proposal = makeProposal({ user_id: harness.userId, ...overrides });
  createProposalsRepo(harness.db).insert(proposal);
  const approval = makeApproval({ proposal_id: proposal.id, user_id: harness.userId, hash: proposal.hash });
  createApprovalsRepo(harness.db).insert(approval);
  return { proposal, approval };
}

async function holdFirstSlot(harness: CoreHarness) {
  const from = harness.clock.now().toISOString();
  const to = new Date(harness.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await harness.client.search_providers(harness.userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = providers[0]!;
  const slot = provider.slots[0]!;
  const { hold } = await harness.client.hold_slot(harness.userId, { provider_id: provider.id, slot });
  return hold;
}

describe('resolvePendingIntents (plan §8 startup recovery)', () => {
  let harness: CoreHarness | undefined;

  afterEach(async () => {
    if (harness) await harness.close();
    harness = undefined;
  });

  it('S14 restart mid-booking → recovery resolves intent from provider status', async ({ task }) => {
    task.meta.expected =
      'a pending intent whose book() timed out but the provider actually booked resolves to succeeded, with a synced bookings row, on the next startup recovery pass';

    harness = await createCoreHarness();
    const admin = createProviderAdminClient({ baseUrl: harness.provider.url });

    const hold = await holdFirstSlot(harness);
    const idempotencyKey = 'book_restart_1';

    await admin.scenario({ outcomes: ['TIMEOUT_BOOKED'] });
    try {
      await harness.client.book(harness.userId, { hold_id: hold.hold_id, idempotency_key: idempotencyKey });
      expect.fail('expected ProviderError timeout');
    } catch (err) {
      expect(ProviderError.isProviderError(err, 'timeout')).toBe(true);
    }

    // The process "crashes" here: the intent row would have been written
    // `pending` before the `book` call, and never updated after the timeout.
    const { approval } = seedApprovedProposal(harness, { hold_id: hold.hold_id });
    const now = harness.clock.now().toISOString();
    createIntentsRepo(harness.db).insertPending({
      idempotency_key: idempotencyKey,
      approval_id: approval.id,
      user_id: harness.userId,
      action: 'book',
      created_at: now,
      updated_at: now,
    });

    const result = await resolvePendingIntents({
      db: harness.db,
      clock: harness.clock,
      providerClient: harness.client,
      trace: harness.trace,
      logger: harness.logger,
    });

    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });

    const intent = createIntentsRepo(harness.db).get(idempotencyKey);
    expect(intent?.status).toBe('succeeded');
    expect(intent?.result).toMatchObject({ booking: { status: 'confirmed' } });

    const bookings = createBookingsRepo(harness.db).list(harness.userId);
    expect(bookings).toHaveLength(1);
    expect(bookings[0]).toMatchObject({ status: 'confirmed', user_id: harness.userId });

    const intentEvents = harness.trace.events.filter((e) => e.type === 'intent');
    expect(intentEvents).toEqual([
      { type: 'intent', idempotency_key: idempotencyKey, action: 'book', status: 'succeeded' },
    ]);

    task.meta.actual = `resolved ${result.resolved} intent(s): ${result.succeeded} succeeded, bookings row synced`;
  });

  it('a pending key the provider never saw is resolved to failed, never silently booked', async () => {
    harness = await createCoreHarness();
    const { approval } = seedApprovedProposal(harness);
    const idempotencyKey = 'book_never_seen_by_provider';
    const now = harness.clock.now().toISOString();
    createIntentsRepo(harness.db).insertPending({
      idempotency_key: idempotencyKey,
      approval_id: approval.id,
      user_id: harness.userId,
      action: 'book',
      created_at: now,
      updated_at: now,
    });

    const result = await resolvePendingIntents({
      db: harness.db,
      clock: harness.clock,
      providerClient: harness.client,
      trace: harness.trace,
      logger: harness.logger,
    });

    expect(result).toEqual({ resolved: 1, succeeded: 0, failed: 1, stillUnknown: 0 });

    const intent = createIntentsRepo(harness.db).get(idempotencyKey);
    expect(intent?.status).toBe('failed');
    expect(intent?.result).toEqual({ reason: 'not_booked_after_restart' });
    expect(createBookingsRepo(harness.db).list(harness.userId)).toHaveLength(0);
  });

  it('provider down (closed server) leaves the intent unknown and never throws', async () => {
    harness = await createCoreHarness();
    const { approval } = seedApprovedProposal(harness);
    const idempotencyKey = 'book_provider_down';
    const now = harness.clock.now().toISOString();
    createIntentsRepo(harness.db).insertPending({
      idempotency_key: idempotencyKey,
      approval_id: approval.id,
      user_id: harness.userId,
      action: 'book',
      created_at: now,
      updated_at: now,
    });

    await harness.provider.close();

    const result = await resolvePendingIntents({
      db: harness.db,
      clock: harness.clock,
      providerClient: harness.client,
      trace: harness.trace,
      logger: harness.logger,
    });

    expect(result).toEqual({ resolved: 0, succeeded: 0, failed: 0, stillUnknown: 1 });
    expect(createIntentsRepo(harness.db).get(idempotencyKey)?.status).toBe('unknown');

    // Provider is already closed; only the db needs cleanup here.
    harness.db.close();
    harness = undefined;
  });

  it('cancel intent resolved via list_bookings: succeeded when the booking is actually cancelled', async () => {
    harness = await createCoreHarness();
    const admin = createProviderAdminClient({ baseUrl: harness.provider.url });
    const hold = await holdFirstSlot(harness);
    const bookOut = await harness.client.book(harness.userId, {
      hold_id: hold.hold_id,
      idempotency_key: 'book_for_cancel_recovery',
    });
    // Cancel's default first-attempt outcome is a transient 503 unless forced (plan §8/provider engine); force success so this test is about recovery, not cancel's own retry path.
    await admin.scenario({ outcomes: ['CANCEL_OK'] });
    await harness.client.cancel(harness.userId, {
      booking_id: bookOut.booking.booking_id,
      idempotency_key: 'cancel_recovery_1',
    });

    const { approval } = seedApprovedProposal(harness, {
      action: 'cancel',
      booking_id: bookOut.booking.booking_id,
    });
    const now = harness.clock.now().toISOString();
    createIntentsRepo(harness.db).insertPending({
      idempotency_key: 'cancel_recovery_1',
      approval_id: approval.id,
      user_id: harness.userId,
      action: 'cancel',
      created_at: now,
      updated_at: now,
    });

    const result = await resolvePendingIntents({
      db: harness.db,
      clock: harness.clock,
      providerClient: harness.client,
      trace: harness.trace,
      logger: harness.logger,
    });

    expect(result).toEqual({ resolved: 1, succeeded: 1, failed: 0, stillUnknown: 0 });
    const intent = createIntentsRepo(harness.db).get('cancel_recovery_1');
    expect(intent?.status).toBe('succeeded');
    expect(createBookingsRepo(harness.db).get(harness.userId, bookOut.booking.booking_id)?.status).toBe(
      'cancelled',
    );
  });
});
