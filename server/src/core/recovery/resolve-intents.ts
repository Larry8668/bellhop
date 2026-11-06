import type Database from 'better-sqlite3';
import type { Booking } from '@bellhop/shared/contracts';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../../provider-client/index.js';
import { ProviderError } from '../../provider-client/errors.js';
import type { TraceWriter } from '../../trace/writer.js';
import { toAppBooking } from '../actions/app-booking.js';
import { isTimeout, isTransient } from '../actions/context.js';
import type { ExecutionOutcome, SuccessOutcome } from '../actions/outcomes.js';
import { createTracedCall, type TracedProviderCall } from '../actions/traced-call.js';
import { createIntentService, type IntentService } from '../intents/service.js';
import {
  createApprovalsRepo,
  createBookingsRepo,
  createIntentsRepo,
  createProposalsRepo,
  createTaskStateRepo,
} from '../repo/index.js';
import { createStateMachine, type StateMachine } from '../state/machine.js';
import type { Intent, Proposal, TaskStateName } from '../types.js';

export interface ResolvePendingIntentsResult {
  /** Intents moved to `succeeded` or `failed` (plan §8). */
  resolved: number;
  succeeded: number;
  failed: number;
  /** The provider never answered conclusively (down, timeout, transient) — left `unknown` for a later pass. */
  stillUnknown: number;
}

export interface ResolvePendingIntentsDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  trace: TraceWriter;
  logger: Logger;
}

type Resolution = 'succeeded' | 'failed' | 'unknown';

interface RecoveryContext {
  clock: Clock;
  log: Logger;
  call: TracedProviderCall;
  intents: IntentService;
  stateMachine: StateMachine;
  approvalsRepo: ReturnType<typeof createApprovalsRepo>;
  proposalsRepo: ReturnType<typeof createProposalsRepo>;
  bookingsRepo: ReturnType<typeof createBookingsRepo>;
  taskStateRepo: ReturnType<typeof createTaskStateRepo>;
}

/** Only an errand still in flight is settled; a user who has since moved on keeps their current state. */
const SETTLE_PATH: Record<'DONE' | 'FAILED', TaskStateName[]> = {
  DONE: ['EXECUTING', 'VERIFYING', 'DONE'],
  FAILED: ['FAILED'],
};
const IN_FLIGHT: ReadonlySet<TaskStateName> = new Set(['APPROVED', 'EXECUTING', 'VERIFYING']);

function nowIso(ctx: RecoveryContext): string {
  return ctx.clock.now().toISOString();
}

function settleTaskState(ctx: RecoveryContext, intent: Intent, to: 'DONE' | 'FAILED'): void {
  const userId = intent.user_id;
  const current = ctx.taskStateRepo.get(userId)?.state ?? 'GATHERING';
  if (!IN_FLIGHT.has(current)) {
    ctx.log.info({ userId, idempotency_key: intent.idempotency_key, current, to }, 'recovery: task moved on, state left');
    return;
  }
  const path = SETTLE_PATH[to];
  try {
    for (const step of path.slice(path.indexOf(current) + 1)) {
      ctx.stateMachine.transition(userId, step, `${intent.action} resolved by startup recovery`);
    }
  } catch (err) {
    ctx.log.error({ err, userId, idempotency_key: intent.idempotency_key, to }, 'recovery: could not settle task state');
  }
}

/** Walks intent → approval → proposal: only the approved proposal knows the hold / booking id (plan §5/§7). */
function proposalFor(ctx: RecoveryContext, intent: Intent): Proposal | undefined {
  const approval = ctx.approvalsRepo.get(intent.user_id, intent.approval_id);
  if (approval === undefined) return undefined;
  return ctx.proposalsRepo.get(intent.user_id, approval.proposal_id);
}

function markUnknown(ctx: RecoveryContext, intent: Intent, err: unknown, what: string): Resolution {
  ctx.log.warn({ err, idempotency_key: intent.idempotency_key, action: intent.action }, `recovery: ${what}, left unknown`);
  ctx.intents.unknown(intent.idempotency_key);
  return 'unknown';
}

function succeed(ctx: RecoveryContext, intent: Intent, outcome: SuccessOutcome): Resolution {
  ctx.intents.succeed(intent.idempotency_key, outcome);
  ctx.bookingsRepo.upsert(outcome.booking);
  settleTaskState(ctx, intent, 'DONE');
  return 'succeeded';
}

function fail(ctx: RecoveryContext, intent: Intent, outcome: Extract<ExecutionOutcome, { kind: 'failed' }>): Resolution {
  ctx.log.info({ idempotency_key: intent.idempotency_key, action: intent.action, code: outcome.code }, 'recovery: failed');
  ctx.intents.fail(intent.idempotency_key, outcome);
  settleTaskState(ctx, intent, 'FAILED');
  return 'failed';
}

function booked(ctx: RecoveryContext, intent: Intent, booking: Booking): Resolution {
  // Invariant 2: the user id is ours (the intent row), never the provider payload's.
  return succeed(ctx, intent, { kind: 'booked', booking: toAppBooking(intent.user_id, booking, nowIso(ctx)), replayed: false });
}

/**
 * Plan §8: `not_booked` → ONE retry with the SAME key and the approved hold.
 * A late-landing first attempt shares the key, so the provider dedupes it;
 * asking the user to re-approve would mint a new key and could book twice.
 */
async function resolveBook(ctx: RecoveryContext, intent: Intent): Promise<Resolution> {
  const key = intent.idempotency_key;
  let status;
  try {
    status = await ctx.call('get_booking_status', intent.user_id, { idempotency_key: key });
  } catch (err) {
    return markUnknown(ctx, intent, err, 'get_booking_status failed');
  }
  if (status.status === 'booked') {
    if (status.booking === null) return markUnknown(ctx, intent, undefined, 'booked status without a booking');
    return booked(ctx, intent, status.booking);
  }

  const holdId = proposalFor(ctx, intent)?.hold_id ?? null;
  if (holdId === null) {
    ctx.log.error({ idempotency_key: key }, 'recovery: book intent has no approved hold to retry');
    return markUnknown(ctx, intent, undefined, 'no hold to retry');
  }

  ctx.intents.attempt(key);
  try {
    const out = await ctx.call('book', intent.user_id, { hold_id: holdId, idempotency_key: key });
    return booked(ctx, intent, out.booking);
  } catch (err) {
    if (!(err instanceof ProviderError) || isTimeout(err) || isTransient(err)) {
      return markUnknown(ctx, intent, err, 'same-key book retry inconclusive');
    }
    return fail(ctx, intent, { kind: 'failed', code: err.code, message: err.message });
  }
}

/**
 * `get_booking_status` only tracks `book` keys, so cancel/reschedule are
 * checked against the booking's current status via `list_bookings`.
 */
async function resolveBookingChange(ctx: RecoveryContext, intent: Intent): Promise<Resolution> {
  const expected = intent.action === 'cancel' ? 'cancelled' : 'rescheduled';
  const bookingId = proposalFor(ctx, intent)?.booking_id ?? null;

  let current: Booking | undefined;
  if (bookingId !== null) {
    try {
      const { bookings } = await ctx.call('list_bookings', intent.user_id, { user_id: intent.user_id });
      current = bookings.find((b) => b.booking_id === bookingId);
    } catch (err) {
      return markUnknown(ctx, intent, err, 'list_bookings failed');
    }
  }

  if (current === undefined || current.status !== expected) {
    return fail(ctx, intent, {
      kind: 'failed',
      code: `not_${expected}_after_restart`,
      message: `the provider shows the booking was not ${expected}`,
    });
  }

  const booking = toAppBooking(intent.user_id, current, nowIso(ctx));
  if (intent.action === 'cancel') return succeed(ctx, intent, { kind: 'cancelled', booking, replayed: false });
  const previousSlot = ctx.bookingsRepo.get(intent.user_id, booking.booking_id)?.slot ?? booking.slot;
  return succeed(ctx, intent, { kind: 'rescheduled', booking, previous_slot: previousSlot, replayed: false });
}

/**
 * Must run before the server accepts turns (plan §8): resolves every
 * `pending`/`unknown` intent against the provider's own record, so a crash
 * mid-action never leaves the app lying about what happened.
 */
export async function resolvePendingIntents(deps: ResolvePendingIntentsDeps): Promise<ResolvePendingIntentsResult> {
  const { db, clock, providerClient, trace, logger } = deps;
  const log = childLogger(logger, 'recovery');
  const ctx: RecoveryContext = {
    clock,
    log,
    call: createTracedCall({ providerClient, clock, trace }),
    intents: createIntentService({ db, clock, trace, logger }),
    stateMachine: createStateMachine({ db, clock, trace, logger }),
    approvalsRepo: createApprovalsRepo(db),
    proposalsRepo: createProposalsRepo(db),
    bookingsRepo: createBookingsRepo(db),
    taskStateRepo: createTaskStateRepo(db),
  };

  const counts: Record<Resolution, number> = { succeeded: 0, failed: 0, unknown: 0 };
  for (const intent of createIntentsRepo(db).listUnresolved()) {
    let resolution: Resolution;
    try {
      resolution = intent.action === 'book' ? await resolveBook(ctx, intent) : await resolveBookingChange(ctx, intent);
    } catch (err) {
      // One broken row must not block startup; it stays unresolved for the next pass.
      log.error({ err, idempotency_key: intent.idempotency_key, action: intent.action }, 'recovery: intent failed to resolve');
      resolution = 'unknown';
    }
    counts[resolution] += 1;
  }

  const result = {
    resolved: counts.succeeded + counts.failed,
    succeeded: counts.succeeded,
    failed: counts.failed,
    stillUnknown: counts.unknown,
  };
  log.info(result, 'startup intent recovery complete');
  return result;
}
