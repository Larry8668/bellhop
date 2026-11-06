import { ProviderError } from '../../provider-client/errors.js';
import { toAppBooking } from './app-booking.js';
import {
  alternativesFrom,
  attemptCall,
  finishFailed,
  finishSlotGone,
  finishSuccess,
  nowIso,
  withSameKeyRetries,
  type ActionDeps,
  type ActionRun,
} from './context.js';
import type { ExecutionOutcome } from './outcomes.js';

export async function runReschedule(deps: ActionDeps, run: ActionRun): Promise<ExecutionOutcome> {
  const bookingId = run.proposal.booking_id;
  if (bookingId === null) throw new Error(`reschedule proposal ${run.proposal.id} has no booking_id`);

  const result = await withSameKeyRetries(deps, run, () =>
    attemptCall(deps, run, 'reschedule', {
      booking_id: bookingId,
      slot: run.proposal.slot,
      idempotency_key: run.key,
    }),
  );
  if (result.ok) {
    return finishSuccess(deps, run, {
      kind: 'rescheduled',
      booking: toAppBooking(run.userId, result.value.booking, nowIso(deps)),
      previous_slot: result.value.previous_slot,
      replayed: false,
    });
  }
  if ('outcome' in result) return result.outcome;

  // Plan §8: conflict → alternatives → the caller builds a new proposal for a fresh approval.
  if (result.err instanceof ProviderError && result.err.code === 'slot_conflict') {
    return finishSlotGone(deps, run, 'slot_conflict', alternativesFrom(result.err));
  }
  return finishFailed(deps, run, result.err);
}
