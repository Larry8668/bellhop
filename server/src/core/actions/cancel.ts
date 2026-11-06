import { ProviderError } from '../../provider-client/errors.js';
import { appBookingFromProposal, toAppBooking } from './app-booking.js';
import {
  attemptCall,
  finishFailed,
  finishSuccess,
  nowIso,
  withSameKeyRetries,
  type ActionDeps,
  type ActionRun,
} from './context.js';
import type { ExecutionOutcome } from './outcomes.js';

export async function runCancel(deps: ActionDeps, run: ActionRun): Promise<ExecutionOutcome> {
  const bookingId = run.proposal.booking_id;
  if (bookingId === null) throw new Error(`cancel proposal ${run.proposal.id} has no booking_id`);

  const result = await withSameKeyRetries(deps, run, () =>
    attemptCall(deps, run, 'cancel', { booking_id: bookingId, idempotency_key: run.key }),
  );
  if (result.ok) {
    return finishSuccess(deps, run, {
      kind: 'cancelled',
      booking: toAppBooking(run.userId, result.value.booking, nowIso(deps)),
      replayed: false,
    });
  }
  if ('outcome' in result) return result.outcome;

  // Already cancelled (e.g. by the provider) is the state the user asked for.
  if (result.err instanceof ProviderError && result.err.code === 'already_cancelled') {
    const known = deps.bookingsRepo.get(run.userId, bookingId);
    const booking =
      known !== undefined
        ? { ...known, status: 'cancelled' as const, synced_at: nowIso(deps) }
        : appBookingFromProposal(run.proposal, 'cancelled', nowIso(deps));
    return finishSuccess(deps, run, { kind: 'cancelled', booking, replayed: false });
  }
  return finishFailed(deps, run, result.err);
}
