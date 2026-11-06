import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../provider-client/client.js';
import { ProviderError } from '../provider-client/errors.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { newId } from '../core/ids.js';
import { createBookingsRepo, createConversationsRepo, createEventsRepo, createMessagesRepo } from '../core/repo/index.js';
import type { ProposalService } from '../core/proposals/service.js';
import type { AppBooking, AppEvent, Proposal } from '../core/types.js';
import { PROVIDER_CANCELLED } from './poller.js';
import {
  PreferenceSchema,
  isFutureSlot,
  rankReplacements,
  replacementDateRange,
  type Preference,
  type ReplacementOption,
} from './replacements.js';

/** Holds tried per event. The first success wins; the rest stay open. */
const MAX_PROPOSE_ATTEMPTS = 5;

const PrefListSchema = z.array(PreferenceSchema);

export interface ProactiveNotice {
  text: string;
  proposalId?: string;
}

export interface ProcessorDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: Pick<ProviderClient, 'get_provider' | 'search_providers'>;
  engine: { proposals: Pick<ProposalService, 'proposeBooking'> };
  queue: UserQueue;
  logger: Logger;
  /** Active preferences for `userId`. Omitted means no extra filter. */
  prefs?: (userId: string) => Preference[];
  /** Optional push (SSE is wired later). The assistant message is written either way. */
  notify?: (userId: string, notice: ProactiveNotice) => void | Promise<void>;
}

/**
 * Each unprocessed event runs inside `queue.run(userId, 'proactive', …)`
 * so it can't interleave with that user's turn (plan §8, §12).
 *
 * A `provider_cancelled` event whose slot is still in the future is
 * searched (`search_providers`, same service and the cancelled provider's
 * area) and the best match becomes a new booking proposal via
 * `proposeBooking` — a hold and a pending card, never a booking. The user
 * gets an assistant message (conversation created if they have none) and
 * an optional `notify`. No match still notifies, with no proposal.
 * A slot that is no longer in the future is marked processed with no
 * message and no notify.
 *
 * Provider errors leave the event unprocessed so the next tick retries.
 * `notify` failures are logged; the message row is the record, and the
 * event is still marked processed.
 */
export async function processEvents(deps: ProcessorDeps): Promise<void> {
  const log = childLogger(deps.logger, 'proactive.processor');
  const eventsRepo = createEventsRepo(deps.db);
  const bookingsRepo = createBookingsRepo(deps.db);

  for (const event of eventsRepo.listUnprocessed()) {
    try {
      await deps.queue.run(event.user_id, 'proactive', () => handleEvent(deps, log, eventsRepo, bookingsRepo, event));
    } catch (err) {
      log.error({ err, eventId: event.id, userId: event.user_id }, 'proactive event failed; left unprocessed');
    }
  }
}

async function handleEvent(
  deps: ProcessorDeps,
  log: Logger,
  eventsRepo: ReturnType<typeof createEventsRepo>,
  bookingsRepo: ReturnType<typeof createBookingsRepo>,
  event: AppEvent,
): Promise<void> {
  const stillOpen = eventsRepo.listUnprocessed(event.user_id).some((row) => row.id === event.id);
  if (!stillOpen) return;

  if (event.type !== PROVIDER_CANCELLED || event.booking_id === null) {
    log.warn({ eventId: event.id, type: event.type }, 'proactive: event is not a provider cancellation; marking processed');
    eventsRepo.markProcessed(event.id);
    return;
  }

  const booking = bookingsRepo.get(event.user_id, event.booking_id);
  if (booking === undefined || booking.user_id !== event.user_id) {
    log.warn({ eventId: event.id, bookingId: event.booking_id }, 'proactive: booking missing for this user; marking processed');
    eventsRepo.markProcessed(event.id);
    return;
  }

  if (!isFutureSlot(booking.slot.start, deps.clock.nowMs())) {
    log.info({ userId: booking.user_id, bookingId: booking.booking_id }, 'proactive: slot is not in the future; no notification');
    eventsRepo.markProcessed(event.id);
    return;
  }

  const loaded = await loadOptions(deps, log, booking);
  if (loaded === undefined) return;

  const ranked = rankReplacements(loaded.options, readPrefs(deps, log, booking.user_id), {
    excludeProviderId: booking.provider_id,
    nowMs: deps.clock.nowMs(),
  });
  const proposal = await proposeBest(deps, log, booking, ranked);
  await deliver(deps, log, eventsRepo, event.id, booking, loaded.area, proposal, ranked.length === 0);
}

async function loadOptions(
  deps: ProcessorDeps,
  log: Logger,
  booking: AppBooking,
): Promise<{ area: string; options: ReplacementOption[] } | undefined> {
  try {
    const { provider } = await deps.providerClient.get_provider(booking.user_id, { provider_id: booking.provider_id });
    const { providers } = await deps.providerClient.search_providers(booking.user_id, {
      service: booking.service,
      area: provider.area,
      date_range: replacementDateRange(deps.clock.nowMs()),
    });
    const options: ReplacementOption[] = [];
    for (const summary of providers) {
      for (const slot of summary.slots) {
        options.push({
          providerId: summary.id,
          providerName: summary.name,
          rating: summary.rating,
          price: summary.price,
          slot,
        });
      }
    }
    return { area: provider.area, options };
  } catch (err) {
    if (!(err instanceof ProviderError)) throw err;
    log.warn(
      { err, userId: booking.user_id, bookingId: booking.booking_id, code: err.code },
      'proactive: replacement search failed; will retry',
    );
    return undefined;
  }
}

function readPrefs(deps: ProcessorDeps, log: Logger, userId: string): Preference[] {
  if (deps.prefs === undefined) return [];
  const parsed = PrefListSchema.safeParse(deps.prefs(userId));
  if (!parsed.success) {
    log.warn({ userId }, 'proactive: prefs did not match { key, value }[]; ignoring them');
    return [];
  }
  return parsed.data;
}

async function proposeBest(
  deps: ProcessorDeps,
  log: Logger,
  booking: AppBooking,
  ranked: readonly ReplacementOption[],
): Promise<Proposal | undefined> {
  const limit = Math.min(ranked.length, MAX_PROPOSE_ATTEMPTS);
  for (let i = 0; i < limit; i += 1) {
    const option = ranked[i];
    if (option === undefined) break;
    const result = await deps.engine.proposals.proposeBooking(booking.user_id, {
      provider_id: option.providerId,
      slot: option.slot,
    });
    if (result.ok) {
      log.info(
        { userId: booking.user_id, bookingId: booking.booking_id, proposalId: result.proposal.id },
        'proactive replacement proposed',
      );
      return result.proposal;
    }
    log.warn(
      { userId: booking.user_id, bookingId: booking.booking_id, code: result.code, providerId: option.providerId },
      'proactive: replacement hold failed',
    );
    if (result.code === 'invalid_state') break;
  }
  return undefined;
}

class EventAlreadyProcessed extends Error {
  constructor() {
    super('proactive event already processed');
    this.name = 'EventAlreadyProcessed';
  }
}

async function deliver(
  deps: ProcessorDeps,
  log: Logger,
  eventsRepo: ReturnType<typeof createEventsRepo>,
  eventId: number,
  booking: AppBooking,
  area: string,
  proposal: Proposal | undefined,
  noneMatched: boolean,
): Promise<void> {
  const text = messageText(booking, area, proposal, noneMatched);
  const now = deps.clock.now().toISOString();
  const conversationsRepo = createConversationsRepo(deps.db);
  const messagesRepo = createMessagesRepo(deps.db);

  // Message and processed flag commit together. A lost compare-and-set rolls
  // the message back so a retry doesn't double-notify.
  try {
    deps.db.transaction(() => {
      const conversation = conversationsRepo.ensureConversation(booking.user_id, now);
      messagesRepo.append({
        id: newId('msg'),
        conversation_id: conversation.id,
        user_id: booking.user_id,
        role: 'assistant',
        text,
        proposal_id: proposal?.id ?? null,
        created_at: now,
      });
      if (!eventsRepo.markProcessed(eventId)) throw new EventAlreadyProcessed();
    })();
  } catch (err) {
    if (err instanceof EventAlreadyProcessed) {
      log.warn({ userId: booking.user_id, bookingId: booking.booking_id, eventId }, 'proactive: event already processed');
      return;
    }
    throw err;
  }

  if (deps.notify === undefined) return;
  const notice: ProactiveNotice = proposal === undefined ? { text } : { text, proposalId: proposal.id };
  try {
    await deps.notify(booking.user_id, notice);
  } catch (err) {
    log.error({ err, userId: booking.user_id, proposalId: proposal?.id }, 'proactive notify failed');
  }
}

function messageText(booking: AppBooking, area: string, proposal: Proposal | undefined, noneMatched: boolean): string {
  const service = booking.service.replaceAll('_', ' ');
  const lead = `${booking.provider_name} cancelled your ${service} booking in ${area} on ${booking.slot.start}.`;
  if (proposal !== undefined) {
    return `${lead} I held a replacement with ${proposal.provider_name} on ${proposal.slot.start} for ₹${proposal.price}. Confirm the card to book it — nothing is booked until you approve.`;
  }
  if (noneMatched) {
    return `${lead} I couldn't find a replacement in ${area} that matches your preferences. Nothing new is booked.`;
  }
  return `${lead} I couldn't hold a replacement in ${area}. Nothing new is booked.`;
}
