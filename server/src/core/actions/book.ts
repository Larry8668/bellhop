import type { Booking, Hold } from '@bellhop/shared/contracts';
import { ProviderError } from '../../provider-client/errors.js';
import { proposalHash } from '../approvals/hash.js';
import { isHoldExpired } from '../proposals/service.js';
import type { Proposal } from '../types.js';
import { toAppBooking } from './app-booking.js';
import {
  attemptCall,
  alternativesFrom,
  finishFailed,
  finishSlotGone,
  finishSuccess,
  finishUnconfirmed,
  isTimeout,
  isTransient,
  moveTo,
  nowIso,
  type ActionDeps,
  type ActionRun,
} from './context.js';
import type { ExecutionOutcome, SuccessOutcome } from './outcomes.js';

const SLOT_GONE_ON_HOLD = new Set(['slot_unavailable', 'slot_taken', 'provider_not_found']);

type HoldRefresh =
  | { kind: 'same'; proposal: Proposal }
  | { kind: 'changed'; hold: Hold }
  | { kind: 'gone' }
  | { kind: 'error'; err: unknown };

/** Plan §7: re-hold the same slot and recompute the hash from the actual hold. */
async function refreshHold(deps: ActionDeps, userId: string, proposal: Proposal): Promise<HoldRefresh> {
  let hold: Hold;
  try {
    ({ hold } = await deps.call('hold_slot', userId, { provider_id: proposal.provider_id, slot: proposal.slot }));
  } catch (err) {
    if (err instanceof ProviderError && SLOT_GONE_ON_HOLD.has(err.code)) return { kind: 'gone' };
    return { kind: 'error', err };
  }
  const hash = proposalHash({
    action: 'book',
    provider_id: hold.provider_id,
    slot: hold.slot,
    price: hold.price,
    booking_id: null,
  });
  if (hash !== proposal.hash) return { kind: 'changed', hold };

  const update = { hold_id: hold.hold_id, hold_expires_at: hold.expires_at, price: hold.price, hash };
  deps.proposalsRepo.updateHold(userId, proposal.id, update, nowIso(deps));
  deps.log.info({ userId, proposalId: proposal.id, holdId: hold.hold_id }, 'identical re-hold, proceeding');
  return { kind: 'same', proposal: { ...proposal, ...update } };
}

/** Price moved (up or down): the old card is no longer what the user approved, so ask again (plan §7, H4/H5). */
function repropose(deps: ActionDeps, userId: string, proposal: Proposal, hold: Hold): ExecutionOutcome {
  deps.proposalsRepo.setStatus(userId, proposal.id, 'superseded', nowIso(deps));
  const next = deps.proposals.proposeFromHold(userId, proposal, hold);
  deps.log.info(
    { userId, proposalId: proposal.id, nextProposalId: next.id, previous: proposal.price, next: hold.price },
    'hold price changed, re-approval needed',
  );
  return { kind: 'needs_reapproval', proposal: next, previous_price: proposal.price, new_price: hold.price };
}

/**
 * Runs before the approval is consumed: an expired hold is re-held; an
 * identical re-hold continues silently, anything else voids the approval
 * without booking or consuming anything.
 */
export async function prepareBook(
  deps: ActionDeps,
  userId: string,
  approvalId: string,
  proposal: Proposal,
): Promise<{ proposal: Proposal } | { outcome: ExecutionOutcome }> {
  if (proposal.hold_id !== null && !isHoldExpired(proposal, deps.clock.nowMs())) return { proposal };

  const refreshed = await refreshHold(deps, userId, proposal);
  switch (refreshed.kind) {
    case 'same':
      return { proposal: refreshed.proposal };
    case 'changed':
      deps.approvals.void(userId, approvalId, 'price_changed');
      return { outcome: repropose(deps, userId, proposal, refreshed.hold) };
    case 'gone':
      deps.approvals.void(userId, approvalId, 'hold_expired');
      deps.proposalsRepo.setStatus(userId, proposal.id, 'expired', nowIso(deps));
      moveTo(deps, userId, 'PROPOSED', 'hold expired and slot gone');
      return { outcome: { kind: 'slot_gone', reason: 'hold_expired', alternatives: [] } };
    case 'error':
      deps.log.error({ err: refreshed.err, userId, approvalId }, 're-hold failed before execution');
      return {
        outcome:
          refreshed.err instanceof ProviderError
            ? { kind: 'failed', code: refreshed.err.code, message: refreshed.err.message }
            : { kind: 'failed', code: 'internal', message: 're-hold failed' },
      };
  }
}

function booked(deps: ActionDeps, run: ActionRun, booking: Booking): SuccessOutcome {
  return finishSuccess(deps, run, {
    kind: 'booked',
    booking: toAppBooking(run.userId, booking, nowIso(deps)),
    replayed: false,
  });
}

function bookOnce(deps: ActionDeps, run: ActionRun) {
  const holdId = run.proposal.hold_id;
  if (holdId === null) throw new Error(`book proposal ${run.proposal.id} has no hold`);
  return attemptCall(deps, run, 'book', { hold_id: holdId, idempotency_key: run.key });
}

/**
 * Plan §8: after a timeout the provider's status is the source of truth.
 * `not_booked` → retry with the SAME key (bounded); still unknown after
 * `limits.statusChecks` checks → unconfirmed, never success.
 */
async function verifyAfterTimeout(deps: ActionDeps, run: ActionRun): Promise<ExecutionOutcome> {
  moveTo(deps, run.userId, 'VERIFYING', 'book timed out');
  let checks = 0;
  let retries = 0;
  while (checks < deps.limits.statusChecks) {
    checks += 1;
    let status;
    try {
      status = await deps.call('get_booking_status', run.userId, { idempotency_key: run.key });
    } catch (err) {
      deps.log.warn({ err, userId: run.userId, idempotency_key: run.key, checks }, 'status check failed');
      continue;
    }
    if (status.status === 'booked' && status.booking !== null) return booked(deps, run, status.booking);
    if (retries >= deps.limits.retriesPerTool) break;

    retries += 1;
    try {
      const out = await bookOnce(deps, run);
      return booked(deps, run, out.booking);
    } catch (err) {
      if (isTimeout(err) || isTransient(err)) continue;
      if (err instanceof ProviderError && err.code === 'slot_taken') {
        return finishSlotGone(deps, run, 'slot_taken', alternativesFrom(err));
      }
      if (err instanceof ProviderError && err.code === 'hold_expired') {
        return finishSlotGone(deps, run, 'hold_expired', []);
      }
      return finishFailed(deps, run, err);
    }
  }
  return finishUnconfirmed(deps, run, checks);
}

export async function runBook(deps: ActionDeps, initial: ActionRun): Promise<ExecutionOutcome> {
  let run = initial;
  let holdRefreshed = false;
  let transientRetries = 0;

  for (;;) {
    try {
      const out = await bookOnce(deps, run);
      return booked(deps, run, out.booking);
    } catch (err) {
      if (!(err instanceof ProviderError)) throw err;
      if (isTimeout(err)) return verifyAfterTimeout(deps, run);

      if (err.code === 'slot_taken') return finishSlotGone(deps, run, 'slot_taken', alternativesFrom(err));

      if (err.code === 'hold_expired') {
        // H10: one re-hold; a second expiry ends the attempt.
        if (holdRefreshed) return finishSlotGone(deps, run, 'hold_expired', []);
        holdRefreshed = true;
        const refreshed = await refreshHold(deps, run.userId, run.proposal);
        if (refreshed.kind === 'same') {
          run = { ...run, proposal: refreshed.proposal };
          continue;
        }
        if (refreshed.kind === 'changed') {
          const outcome = repropose(deps, run.userId, run.proposal, refreshed.hold);
          deps.intents.fail(run.key, outcome);
          return outcome;
        }
        if (refreshed.kind === 'gone') return finishSlotGone(deps, run, 'hold_expired', []);
        return finishFailed(deps, run, refreshed.err);
      }

      if (err.code === 'transient' && transientRetries < deps.limits.retriesPerTool) {
        transientRetries += 1;
        deps.log.warn({ userId: run.userId, idempotency_key: run.key, transientRetries }, 'book transient, retrying');
        continue;
      }
      return finishFailed(deps, run, err);
    }
  }
}
