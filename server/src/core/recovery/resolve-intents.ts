import type Database from 'better-sqlite3';
import type { Booking } from '@bellhop/shared/contracts';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../../provider-client/index.js';
import type { TraceWriter } from '../../trace/writer.js';
import { createApprovalsRepo } from '../repo/approvals.repo.js';
import { createBookingsRepo } from '../repo/bookings.repo.js';
import { createIntentsRepo } from '../repo/intents.repo.js';
import { createProposalsRepo } from '../repo/proposals.repo.js';
import type { AppBooking, Intent } from '../types.js';

export interface ResolvePendingIntentsResult {
  /** Intents moved to `succeeded` or `failed` (plan §8). */
  resolved: number;
  succeeded: number;
  failed: number;
  /** Provider status check threw (down/unreachable) — left `unknown` for a later retry. */
  stillUnknown: number;
}

export interface ResolvePendingIntentsDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  trace: TraceWriter;
  logger: Logger;
}

function mapProviderBooking(booking: Booking, syncedAt: string): AppBooking {
  return {
    booking_id: booking.booking_id,
    user_id: booking.user_id,
    provider_id: booking.provider_id,
    provider_name: booking.provider_name,
    service: booking.service,
    slot: booking.slot,
    price: booking.price,
    currency: booking.currency,
    status: booking.status,
    synced_at: syncedAt,
  };
}

/**
 * A `cancel`/`reschedule` intent has no booking id of its own — only the
 * proposal that was approved does — so recovery has to walk
 * intent -> approval -> proposal to find it (plan §5/§7/§8).
 */
function findBookingIdForIntent(db: Database.Database, intent: Intent): string | null {
  const approval = createApprovalsRepo(db).get(intent.user_id, intent.approval_id);
  if (approval === undefined) return null;
  const proposal = createProposalsRepo(db).get(intent.user_id, approval.proposal_id);
  return proposal?.booking_id ?? null;
}

/**
 * Resolves one `pending`/`unknown` intent that was never booked under the
 * `book` action: it must be `failed`, never silently re-booked, because the
 * approval was for a slot/price at a moment that has already passed — the
 * user will be asked to confirm again (plan §8).
 */
function resolveUnbookedBookIntent(
  intentsRepo: ReturnType<typeof createIntentsRepo>,
  trace: TraceWriter,
  intent: Intent,
  now: string,
): 'failed' {
  const result = { reason: 'not_booked_after_restart' };
  intentsRepo.setStatus(intent.idempotency_key, 'failed', now, result);
  trace.emit({
    type: 'intent',
    idempotency_key: intent.idempotency_key,
    action: intent.action,
    status: 'failed',
  });
  return 'failed';
}

/**
 * Resolves one `pending`/`unknown` `cancel`/`reschedule` intent by checking
 * the booking's current status via `list_bookings` — the provider's
 * booking-idempotency lookup (`get_booking_status`) only tracks `book`
 * calls, so it can never confirm these (plan §8).
 */
async function resolveCancelOrRescheduleIntent(
  deps: ResolvePendingIntentsDeps,
  intentsRepo: ReturnType<typeof createIntentsRepo>,
  bookingsRepo: ReturnType<typeof createBookingsRepo>,
  log: Logger,
  intent: Intent,
  now: string,
): Promise<'succeeded' | 'failed' | 'unknown'> {
  const expectedStatus = intent.action === 'cancel' ? 'cancelled' : 'rescheduled';
  const bookingId = findBookingIdForIntent(deps.db, intent);

  let currentBooking: Booking | undefined;
  if (bookingId !== null) {
    try {
      const { bookings } = await deps.providerClient.list_bookings(intent.user_id, {
        user_id: intent.user_id,
      });
      currentBooking = bookings.find((b) => b.booking_id === bookingId);
    } catch (err) {
      log.warn(
        { err, idempotency_key: intent.idempotency_key, action: intent.action },
        'recovery: list_bookings failed, leaving intent unknown',
      );
      intentsRepo.setStatus(intent.idempotency_key, 'unknown', now);
      deps.trace.emit({
        type: 'intent',
        idempotency_key: intent.idempotency_key,
        action: intent.action,
        status: 'unknown',
      });
      return 'unknown';
    }
  }

  if (currentBooking !== undefined && currentBooking.status === expectedStatus) {
    intentsRepo.setStatus(intent.idempotency_key, 'succeeded', now, { booking: currentBooking });
    bookingsRepo.upsert(mapProviderBooking(currentBooking, now));
    deps.trace.emit({
      type: 'intent',
      idempotency_key: intent.idempotency_key,
      action: intent.action,
      status: 'succeeded',
    });
    return 'succeeded';
  }

  const result = { reason: `not_${expectedStatus}_after_restart` };
  intentsRepo.setStatus(intent.idempotency_key, 'failed', now, result);
  deps.trace.emit({
    type: 'intent',
    idempotency_key: intent.idempotency_key,
    action: intent.action,
    status: 'failed',
  });
  return 'failed';
}

/**
 * Must run before the server accepts turns (plan §8): resolves every
 * `pending`/`unknown` intent against the provider's own record of what
 * happened, so a crash mid-booking never leaves the app lying about whether
 * something was booked, cancelled, or rescheduled.
 */
export async function resolvePendingIntents(
  deps: ResolvePendingIntentsDeps,
): Promise<ResolvePendingIntentsResult> {
  const { db, clock, providerClient, trace, logger } = deps;
  const log = childLogger(logger, 'recovery');
  const intentsRepo = createIntentsRepo(db);
  const bookingsRepo = createBookingsRepo(db);

  const unresolved = intentsRepo.listUnresolved();
  let succeeded = 0;
  let failed = 0;
  let stillUnknown = 0;

  for (const intent of unresolved) {
    const now = clock.now().toISOString();

    let statusCheck: { status: 'booked' | 'not_booked'; booking: Booking | null };
    try {
      statusCheck = await providerClient.get_booking_status(intent.user_id, {
        idempotency_key: intent.idempotency_key,
      });
    } catch (err) {
      log.warn(
        { err, idempotency_key: intent.idempotency_key, action: intent.action },
        'recovery: get_booking_status failed, leaving intent unknown',
      );
      intentsRepo.setStatus(intent.idempotency_key, 'unknown', now);
      trace.emit({
        type: 'intent',
        idempotency_key: intent.idempotency_key,
        action: intent.action,
        status: 'unknown',
      });
      stillUnknown += 1;
      continue;
    }

    if (statusCheck.status === 'booked' && statusCheck.booking !== null) {
      intentsRepo.setStatus(intent.idempotency_key, 'succeeded', now, { booking: statusCheck.booking });
      bookingsRepo.upsert(mapProviderBooking(statusCheck.booking, now));
      trace.emit({
        type: 'intent',
        idempotency_key: intent.idempotency_key,
        action: intent.action,
        status: 'succeeded',
      });
      succeeded += 1;
      continue;
    }

    if (intent.action === 'book') {
      resolveUnbookedBookIntent(intentsRepo, trace, intent, now);
      failed += 1;
      continue;
    }

    const outcome = await resolveCancelOrRescheduleIntent(deps, intentsRepo, bookingsRepo, log, intent, now);
    if (outcome === 'succeeded') succeeded += 1;
    else if (outcome === 'failed') failed += 1;
    else stillUnknown += 1;
  }

  const resolved = succeeded + failed;
  log.info({ resolved, succeeded, failed, stillUnknown }, 'startup intent recovery complete');
  return { resolved, succeeded, failed, stillUnknown };
}
