import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary, Slot } from '@bellhop/shared/contracts';
import { createProviderAdminClient } from '../../src/provider-client/index.js';
import { createUserQueue } from '../../src/core/queue/user-queue.js';
import { createMessagesRepo, createProposalsRepo } from '../../src/core/repo/index.js';
import { createProactive, type ProactiveNotice } from '../../src/proactive/index.js';
import { pollBookings } from '../../src/proactive/poller.js';
import { processEvents } from '../../src/proactive/processor.js';
import {
  rankReplacements,
  replacementDateRange,
  slotClockTimeIst,
  type Preference,
  type ReplacementOption,
} from '../../src/proactive/replacements.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { bookThroughEngine, findProvider } from './helpers.js';

interface SeenNotice {
  userId: string;
  text: string;
  proposalId?: string;
}

function futureSlot(h: CoreHarness, provider: ProviderSummary): Slot {
  const slot = provider.slots.find((candidate) => Date.parse(candidate.start) > h.clock.nowMs());
  if (slot === undefined) throw new Error('provider has no slot strictly after now');
  return slot;
}

function harnessDeps(h: CoreHarness, opts: { prefs?: (userId: string) => Preference[]; notify?: (userId: string, notice: ProactiveNotice) => void } = {}) {
  return {
    db: h.db,
    clock: h.clock,
    providerClient: h.client,
    engine: h.engine,
    queue: createUserQueue({ logger: h.logger }),
    logger: h.logger,
    ...(opts.prefs !== undefined ? { prefs: opts.prefs } : {}),
    ...(opts.notify !== undefined ? { notify: opts.notify } : {}),
  };
}

function optionsFrom(providers: ProviderSummary[]): ReplacementOption[] {
  return providers.flatMap((summary) =>
    summary.slots.map((slot) => ({
      providerId: summary.id,
      providerName: summary.name,
      rating: summary.rating,
      price: summary.price,
      slot,
    })),
  );
}

describe('proactive follow-up', () => {
  let h: CoreHarness;

  beforeEach(async () => {
    h = await createCoreHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('S22 provider cancels → notify, replacement within prefs, fresh approval', async ({ task }) => {
    task.meta.expected =
      'provider cancels a future booking → app booking cancelled, exactly one provider_cancelled event, one assistant message, one new pending proposal within preferences and no approval; a second tick does not duplicate the event or proposal; approving the new proposal then books the replacement';

    const provider = await findProvider(h);
    const bookingId = await bookThroughEngine(h, provider, futureSlot(h, provider));
    const admin = createProviderAdminClient({ baseUrl: h.provider.url });
    await admin.cancelBooking(bookingId);

    const nowMs = h.clock.nowMs();
    const { providers } = await h.client.search_providers(h.userId, {
      service: provider.service,
      area: provider.area,
      date_range: replacementDateRange(nowMs),
    });
    const options = optionsFrom(providers);
    const others = options.filter(
      (option) => option.providerId !== provider.id && Date.parse(option.slot.start) > nowMs,
    );
    const times = [...new Set(others.map((option) => slotClockTimeIst(option.slot.start)))].sort();
    const notBefore = times[Math.floor(times.length / 2)];
    if (notBefore === undefined || times.length < 2) throw new Error('seed has no spread of slot times to filter');
    const afterTime = others.filter((option) => slotClockTimeIst(option.slot.start) >= notBefore);
    const prices = [...new Set(afterTime.map((option) => option.price))].sort((a, b) => a - b);
    const maxPrice = prices[Math.floor((prices.length - 1) / 2)];
    if (maxPrice === undefined) throw new Error('seed has no priced replacement');
    const prefs: Preference[] = [
      { key: 'not_before', value: notBefore },
      { key: 'max_price', value: String(maxPrice) },
    ];
    const ranked = rankReplacements(options, prefs, { excludeProviderId: provider.id, nowMs });
    const best = ranked[0];
    if (best === undefined) throw new Error('prefs filtered out every replacement');
    const unfiltered = rankReplacements(options, [], { excludeProviderId: provider.id, nowMs });

    const notices: SeenNotice[] = [];
    const proactive = createProactive(
      harnessDeps(h, {
        prefs: () => prefs,
        notify: (userId, notice) => {
          notices.push({ userId, text: notice.text, ...(notice.proposalId !== undefined ? { proposalId: notice.proposalId } : {}) });
        },
      }),
    );

    await proactive.tick();

    const pending = createProposalsRepo(h.db).listPending(h.userId);
    const messages = createMessagesRepo(h.db).listRecent(h.userId, 10);
    const events = h.db.prepare('SELECT type, booking_id, processed FROM events').all() as {
      type: string;
      booking_id: string;
      processed: number;
    }[];
    const proposal = pending[0];
    if (proposal === undefined) throw new Error('expected a pending replacement proposal');
    const newApprovals = h.db.prepare('SELECT id FROM approvals WHERE proposal_id = ?').all(proposal.id);

    expect(h.engine.bookings.get(h.userId, bookingId)?.status).toBe('cancelled');
    expect(events).toEqual([{ type: 'provider_cancelled', booking_id: bookingId, processed: 1 }]);
    expect(pending).toHaveLength(1);
    expect(unfiltered.length).toBeGreaterThan(ranked.length);
    expect(proposal).toMatchObject({
      action: 'book',
      status: 'pending',
      provider_id: best.providerId,
      price: best.price,
      slot: best.slot,
    });
    expect(proposal.provider_id).not.toBe(provider.id);
    expect(slotClockTimeIst(proposal.slot.start) >= notBefore).toBe(true);
    expect(proposal.price).toBeLessThanOrEqual(maxPrice);
    expect(proposal.hold_id).not.toBeNull();
    expect(newApprovals).toHaveLength(0);
    expect(h.engine.bookings.list(h.userId).filter((row) => row.status === 'confirmed')).toHaveLength(0);
    expect(h.providerBookings().filter((row) => row.status === 'confirmed')).toHaveLength(0);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: 'assistant', proposal_id: proposal.id, text: notices[0]?.text });
    expect(messages[0]?.text.toLowerCase()).toContain('cancel');
    expect(messages[0]?.text).toContain('nothing is booked until you approve');
    expect(notices).toEqual([{ userId: h.userId, text: messages[0]?.text, proposalId: proposal.id }]);
    expect((h.db.prepare('SELECT COUNT(*) AS n FROM conversations WHERE user_id = ?').get(h.userId) as { n: number }).n).toBe(1);

    await proactive.tick();

    expect(h.db.prepare('SELECT id FROM events').all()).toHaveLength(1);
    expect(createProposalsRepo(h.db).listPending(h.userId).map((row) => row.id)).toEqual([proposal.id]);
    expect(createMessagesRepo(h.db).listRecent(h.userId, 10)).toHaveLength(1);
    h.assertInvariants();

    const approval = h.approve(proposal);
    h.scenario('BOOK_SUCCESS');
    const outcome = await h.engine.executor.execute(h.userId, approval.id);

    expect(outcome).toMatchObject({
      kind: 'booked',
      booking: { provider_id: proposal.provider_id, slot: proposal.slot, price: proposal.price, status: 'confirmed' },
    });
    expect(h.engine.bookings.get(h.userId, bookingId)?.status).toBe('cancelled');
    expect(h.providerBookings().filter((row) => row.status === 'confirmed')).toHaveLength(1);
    h.assertInvariants();

    task.meta.actual = `events=${events.length} pending=${pending.length} approvals_before=${newApprovals.length} notices=${notices.length} replacement=${proposal.provider_id} price=${proposal.price} not_before=${notBefore} max_price=${maxPrice} after_approve=${outcome.kind} confirmed_bookings=${h.providerBookings().filter((row) => row.status === 'confirmed').length}`;
  });

  it('S22 past-slot booking cancelled → no notification', async ({ task }) => {
    task.meta.expected =
      'a provider cancellation whose slot is no longer in the future is marked processed with no assistant message, no notification, and no new proposal';

    const provider = await findProvider(h);
    const bookingId = await bookThroughEngine(h, provider, futureSlot(h, provider));
    const admin = createProviderAdminClient({ baseUrl: h.provider.url });
    await admin.cancelBooking(bookingId);

    const deps = harnessDeps(h);
    await pollBookings(deps);
    const booked = h.engine.bookings.get(h.userId, bookingId);
    if (booked === undefined) throw new Error('missing app booking');
    expect(booked.status).toBe('cancelled');

    h.clock.set(Date.parse(booked.slot.start));
    const notices: SeenNotice[] = [];
    await processEvents({
      ...deps,
      notify: (userId, notice) => {
        notices.push({ userId, text: notice.text, ...(notice.proposalId !== undefined ? { proposalId: notice.proposalId } : {}) });
      },
    });

    const messages = createMessagesRepo(h.db).listRecent(h.userId, 10);
    const pending = createProposalsRepo(h.db).listPending(h.userId);
    const event = h.db.prepare('SELECT processed FROM events WHERE booking_id = ?').get(bookingId) as { processed: number };

    expect(event.processed).toBe(1);
    expect(messages).toEqual([]);
    expect(notices).toEqual([]);
    expect(pending).toEqual([]);
    expect(h.providerBookings().filter((row) => row.status === 'confirmed')).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `processed=${event.processed} messages=${messages.length} notices=${notices.length} pending=${pending.length}`;
  });

  it('notifies without a proposal when no slot matches preferences', async () => {
    const provider = await findProvider(h);
    const bookingId = await bookThroughEngine(h, provider, futureSlot(h, provider));
    const admin = createProviderAdminClient({ baseUrl: h.provider.url });
    await admin.cancelBooking(bookingId);

    const notices: SeenNotice[] = [];
    const proactive = createProactive(
      harnessDeps(h, {
        prefs: () => [
          { key: 'not_before', value: '23:00' },
          { key: 'max_price', value: '1' },
        ],
        notify: (userId, notice) => {
          notices.push({ userId, text: notice.text, ...(notice.proposalId !== undefined ? { proposalId: notice.proposalId } : {}) });
        },
      }),
    );

    await proactive.tick();

    const messages = createMessagesRepo(h.db).listRecent(h.userId, 10);
    expect(h.engine.bookings.get(h.userId, bookingId)?.status).toBe('cancelled');
    expect(createProposalsRepo(h.db).listPending(h.userId)).toEqual([]);
    expect(messages).toHaveLength(1);
    expect(messages[0]?.proposal_id).toBeNull();
    expect(messages[0]?.text.toLowerCase()).toContain('cancel');
    expect(messages[0]?.text).toContain('Nothing new is booked');
    expect(notices).toEqual([{ userId: h.userId, text: messages[0]?.text }]);
    expect((h.db.prepare('SELECT processed FROM events WHERE booking_id = ?').get(bookingId) as { processed: number }).processed).toBe(1);
    h.assertInvariants();
  });
});
