import type { Clock } from '@bellhop/shared/clock';
import { SlotConflictDetailsSchema, type Slot, type ToolInput, type ToolName, type ToolOutput } from '@bellhop/shared/contracts';
import type { Logger } from '@bellhop/shared/logger';
import { ProviderError } from '../../provider-client/errors.js';
import type { ApprovalService } from '../approvals/service.js';
import type { IntentService } from '../intents/service.js';
import type { ProposalService } from '../proposals/service.js';
import type { BookingsRepo, ProposalsRepo, TaskStateRepo } from '../repo/index.js';
import type { StateMachine } from '../state/machine.js';
import type { Proposal, TaskStateName } from '../types.js';
import type { ExecutionOutcome, SuccessOutcome } from './outcomes.js';
import type { TracedProviderCall } from './traced-call.js';

export interface ExecutionLimits {
  /** Max `get_booking_status` checks after a `book` timeout. */
  statusChecks: number;
  /** Max extra provider attempts (same idempotency key) after the first one. */
  retriesPerTool: number;
}

export interface ActionDeps {
  clock: Clock;
  call: TracedProviderCall;
  proposals: ProposalService;
  approvals: ApprovalService;
  intents: IntentService;
  stateMachine: StateMachine;
  proposalsRepo: ProposalsRepo;
  bookingsRepo: BookingsRepo;
  taskStateRepo: TaskStateRepo;
  limits: ExecutionLimits;
  log: Logger;
}

/** One execution of one approved proposal, keyed by `idempotencyKey(action, approvalId)`. */
export interface ActionRun {
  userId: string;
  approvalId: string;
  key: string;
  proposal: Proposal;
}

export function isTimeout(err: unknown): boolean {
  return err instanceof ProviderError && (err.timedOut || err.code === 'timeout');
}

export function isTransient(err: unknown): boolean {
  return err instanceof ProviderError && err.code === 'transient';
}

export function alternativesFrom(err: ProviderError): Slot[] {
  const parsed = SlotConflictDetailsSchema.safeParse(err.details);
  return parsed.success ? parsed.data.alternatives : [];
}

export function nowIso(deps: ActionDeps): string {
  return deps.clock.now().toISOString();
}

/** No-op when already in `to`, so shared helpers can be reached from more than one state. */
export function moveTo(deps: ActionDeps, userId: string, to: TaskStateName, reason: string): void {
  const current = deps.taskStateRepo.get(userId)?.state ?? 'GATHERING';
  if (current !== to) deps.stateMachine.transition(userId, to, reason);
}

/** Counts the attempt on the intent before the request leaves, so `attempts` covers calls that never answer. */
export function attemptCall<N extends ToolName>(
  deps: ActionDeps,
  run: ActionRun,
  tool: N,
  args: ToolInput<N>,
): Promise<ToolOutput<N>> {
  deps.intents.attempt(run.key);
  return deps.call(tool, run.userId, args);
}

/** Intent first: if anything after it throws, the stored result still tells the truth. */
export function finishSuccess(deps: ActionDeps, run: ActionRun, outcome: SuccessOutcome): SuccessOutcome {
  deps.intents.succeed(run.key, outcome);
  deps.bookingsRepo.upsert(outcome.booking);
  moveTo(deps, run.userId, 'VERIFYING', `${run.proposal.action} acknowledged`);
  moveTo(deps, run.userId, 'DONE', `${run.proposal.action} verified`);
  deps.log.info(
    { userId: run.userId, approvalId: run.approvalId, idempotency_key: run.key, kind: outcome.kind },
    'action succeeded',
  );
  return outcome;
}

export function finishSlotGone(
  deps: ActionDeps,
  run: ActionRun,
  reason: 'slot_taken' | 'slot_conflict' | 'hold_expired',
  alternatives: Slot[],
): ExecutionOutcome {
  const outcome: ExecutionOutcome = { kind: 'slot_gone', reason, alternatives };
  deps.intents.fail(run.key, outcome);
  deps.proposalsRepo.setStatus(run.userId, run.proposal.id, 'expired', nowIso(deps));
  moveTo(deps, run.userId, 'PROPOSED', reason);
  deps.log.info({ userId: run.userId, approvalId: run.approvalId, idempotency_key: run.key, reason }, 'slot gone');
  return outcome;
}

export function finishFailed(deps: ActionDeps, run: ActionRun, err: unknown): ExecutionOutcome {
  const outcome: ExecutionOutcome =
    err instanceof ProviderError
      ? { kind: 'failed', code: err.code, message: err.message }
      : { kind: 'failed', code: 'internal', message: 'unexpected error' };
  deps.log.error(
    { err, userId: run.userId, approvalId: run.approvalId, idempotency_key: run.key },
    `${run.proposal.action} failed`,
  );
  deps.intents.fail(run.key, outcome);
  moveTo(deps, run.userId, 'FAILED', `${run.proposal.action} failed: ${outcome.code}`);
  return outcome;
}

/** Plan §8: the provider never answered conclusively — never claim success; startup recovery resolves `unknown`. */
export function finishUnconfirmed(deps: ActionDeps, run: ActionRun, checks: number): ExecutionOutcome {
  deps.intents.unknown(run.key);
  moveTo(deps, run.userId, 'VERIFYING', `${run.proposal.action} unconfirmed`);
  deps.log.warn(
    { userId: run.userId, approvalId: run.approvalId, idempotency_key: run.key, checks },
    `${run.proposal.action} unconfirmed`,
  );
  return { kind: 'unconfirmed', idempotency_key: run.key, checks };
}

/**
 * Same-key retry loop for cancel/reschedule: `transient` and timeouts are
 * retried up to `limits.retriesPerTool` times; any other error is returned
 * to the caller to map. Exhausted on a timeout → unconfirmed, on transient → failed.
 */
export async function withSameKeyRetries<T>(
  deps: ActionDeps,
  run: ActionRun,
  attempt: () => Promise<T>,
): Promise<{ ok: true; value: T } | { ok: false; err: unknown } | { ok: false; outcome: ExecutionOutcome }> {
  let retries = 0;
  for (;;) {
    try {
      return { ok: true, value: await attempt() };
    } catch (err) {
      if (!(err instanceof ProviderError) || !(isTransient(err) || isTimeout(err))) return { ok: false, err };
      if (retries >= deps.limits.retriesPerTool) {
        return { ok: false, outcome: isTimeout(err) ? finishUnconfirmed(deps, run, 0) : finishFailed(deps, run, err) };
      }
      retries += 1;
      deps.log.warn(
        { userId: run.userId, approvalId: run.approvalId, idempotency_key: run.key, code: err.code, retries },
        `${run.proposal.action} retrying with the same key`,
      );
    }
  }
}
