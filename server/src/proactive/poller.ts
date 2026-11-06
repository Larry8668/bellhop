import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../provider-client/client.js';
import { ProviderError } from '../provider-client/errors.js';
import type { AppBooking } from '../core/types.js';
import { createBookingsRepo, createEventsRepo } from '../core/repo/index.js';
import { isFutureSlot } from './replacements.js';

/** One `list_bookings` call per user, capped so a poll can't run away. */
const DEFAULT_MAX_STATUS_CALLS = 50;

export const PROVIDER_CANCELLED = 'provider_cancelled';

export interface PollerDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: Pick<ProviderClient, 'list_bookings'>;
  logger: Logger;
  /** Defaults to 50. Each call is one user's `list_bookings`. */
  maxStatusCalls?: number;
}

export interface StartPollerOpts {
  intervalMs: number;
  tick: () => Promise<void>;
  logger: Logger;
}

/**
 * Confirmed app bookings whose slot is still in the future are checked
 * against the provider. `list_bookings` is the status read: `get_booking_status`
 * keys on hold id or idempotency key, and the app booking row stores neither,
 * while `list_bookings` returns each booking's `status` (plan §12). One call
 * per user, sequential, bounded by `maxStatusCalls`.
 *
 * A provider status of `cancelled` marks the app row cancelled and inserts
 * one `provider_cancelled` event. The insert is skipped when that booking
 * already has one, so a second poll can't duplicate it. Both writes share
 * a transaction. A provider error leaves the row confirmed so the next poll
 * retries it; other users are still checked.
 */
export async function pollBookings(deps: PollerDeps): Promise<void> {
  const log = childLogger(deps.logger, 'proactive.poller');
  const bookingsRepo = createBookingsRepo(deps.db);
  const eventsRepo = createEventsRepo(deps.db);
  const nowMs = deps.clock.nowMs();
  const upcoming = bookingsRepo.listByStatus('confirmed').filter((booking) => isFutureSlot(booking.slot.start, nowMs));

  const byUser = new Map<string, AppBooking[]>();
  for (const booking of upcoming) {
    const group = byUser.get(booking.user_id);
    if (group === undefined) byUser.set(booking.user_id, [booking]);
    else group.push(booking);
  }

  const budget = deps.maxStatusCalls ?? DEFAULT_MAX_STATUS_CALLS;
  let calls = 0;
  for (const [userId, bookings] of byUser) {
    if (calls >= budget) {
      log.warn({ budget }, 'poll stopped: status-call budget exhausted');
      break;
    }
    calls += 1;

    let remote: Awaited<ReturnType<ProviderClient['list_bookings']>>;
    try {
      remote = await deps.providerClient.list_bookings(userId, { user_id: userId });
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      log.error({ err, userId, code: err.code }, 'poll: list_bookings failed; booking stays confirmed for the next poll');
      continue;
    }

    const byId = new Map(remote.bookings.map((booking) => [booking.booking_id, booking]));
    for (const local of bookings) {
      const found = byId.get(local.booking_id);
      if (found === undefined) {
        log.warn({ userId, bookingId: local.booking_id }, 'poll: booking missing at provider');
        continue;
      }
      if (found.status !== 'cancelled') continue;
      recordCancellation(deps, bookingsRepo, eventsRepo, local);
      log.info({ userId, bookingId: local.booking_id }, 'provider cancelled an upcoming booking');
    }
  }
}

function recordCancellation(
  deps: PollerDeps,
  bookingsRepo: ReturnType<typeof createBookingsRepo>,
  eventsRepo: ReturnType<typeof createEventsRepo>,
  booking: AppBooking,
): void {
  const now = deps.clock.now().toISOString();
  deps.db.transaction(() => {
    bookingsRepo.upsert({ ...booking, status: 'cancelled', synced_at: now });
    if (eventsRepo.hasForBooking(PROVIDER_CANCELLED, booking.booking_id)) return;
    eventsRepo.insert({
      user_id: booking.user_id,
      type: PROVIDER_CANCELLED,
      booking_id: booking.booking_id,
      payload: {
        provider_status: 'cancelled',
        provider_id: booking.provider_id,
        service: booking.service,
        slot: booking.slot,
      },
      created_at: now,
    });
  })();
}

/**
 * Repeats `tick` on `intervalMs`. The timer is unref'd so it doesn't keep
 * the process alive on its own. Overlapping ticks are skipped; `stop`
 * clears the timer.
 */
export function startPoller(opts: StartPollerOpts): () => void {
  if (!Number.isInteger(opts.intervalMs) || opts.intervalMs <= 0) {
    throw new Error(`startPoller: intervalMs must be a positive integer, got ${String(opts.intervalMs)}`);
  }
  const log = childLogger(opts.logger, 'proactive.poller');
  let stopped = false;
  let inflight = false;

  const timer = setInterval(() => {
    if (stopped || inflight) return;
    inflight = true;
    void opts
      .tick()
      .catch((err: unknown) => {
        log.error({ err }, 'proactive tick failed');
      })
      .finally(() => {
        inflight = false;
      });
  }, opts.intervalMs);
  timer.unref();

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}
