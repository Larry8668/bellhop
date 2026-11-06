import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../../provider-client/client.js';
import type { TraceWriter } from '../../trace/writer.js';
import type { ApprovalService } from '../approvals/service.js';
import { idempotencyKey, type IntentService } from '../intents/service.js';
import type { ProposalService } from '../proposals/service.js';
import { createApprovalsRepo, createBookingsRepo, createProposalsRepo, createTaskStateRepo } from '../repo/index.js';
import type { StateMachine } from '../state/machine.js';
import type { Action, Intent } from '../types.js';
import { prepareBook, runBook } from './book.js';
import { runCancel } from './cancel.js';
import { moveTo, type ActionDeps, type ActionRun, type ExecutionLimits } from './context.js';
import { ExecutionOutcomeSchema, isSuccessOutcome, type ExecutionOutcome, type SuccessOutcome } from './outcomes.js';
import { runReschedule } from './reschedule.js';
import { createTracedCall } from './traced-call.js';

export type { ExecutionLimits } from './context.js';

export interface ExecutorDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  proposals: ProposalService;
  approvals: ApprovalService;
  intents: IntentService;
  stateMachine: StateMachine;
  trace: TraceWriter;
  logger: Logger;
  limits: ExecutionLimits;
}

export interface Executor {
  /**
   * The only path to a provider side effect (invariant 1). Takes an
   * approval id the user created; never an approval from model output.
   * Always resolves to an outcome — provider errors are never thrown.
   */
  execute(userId: string, approvalId: string): Promise<ExecutionOutcome>;
}

const RUNNERS: Record<Action, (deps: ActionDeps, run: ActionRun) => Promise<ExecutionOutcome>> = {
  book: runBook,
  cancel: runCancel,
  reschedule: runReschedule,
};

type RejectReason = Extract<ExecutionOutcome, { kind: 'rejected' }>['reason'];

export function createExecutor(deps: ExecutorDeps): Executor {
  const { db, clock, providerClient, proposals, approvals, intents, stateMachine, trace, logger, limits } = deps;
  const log = childLogger(logger, 'executor');
  const approvalsRepo = createApprovalsRepo(db);

  const actionDeps: ActionDeps = {
    clock,
    call: createTracedCall({ providerClient, clock, trace }),
    proposals,
    approvals,
    intents,
    stateMachine,
    proposalsRepo: createProposalsRepo(db),
    bookingsRepo: createBookingsRepo(db),
    taskStateRepo: createTaskStateRepo(db),
    limits,
    log,
  };

  function reject(userId: string, approvalId: string, reason: RejectReason): ExecutionOutcome {
    log.warn({ userId, approvalId, reason }, 'execution rejected');
    trace.emit({ type: 'error', where: 'executor', message: `rejected: ${reason}` });
    return { kind: 'rejected', reason };
  }

  /** Scenario 13: a second Confirm on a finished action returns the stored result, not a second effect. */
  function replayStored(intent: Intent | undefined): SuccessOutcome | undefined {
    if (intent?.status !== 'succeeded') return undefined;
    const stored = ExecutionOutcomeSchema.safeParse(intent.result);
    if (!stored.success || !isSuccessOutcome(stored.data)) {
      log.error({ idempotency_key: intent.idempotency_key }, 'succeeded intent has no valid stored outcome');
      return undefined;
    }
    log.info({ userId: intent.user_id, idempotency_key: intent.idempotency_key }, 'replaying stored outcome');
    return { ...stored.data, replayed: true };
  }

  function recoverFromUnexpected(userId: string, approvalId: string, key: string, err: unknown): ExecutionOutcome {
    log.error({ err, userId, approvalId, idempotency_key: key }, 'execution failed unexpectedly');
    trace.emit({ type: 'error', where: 'executor', message: err instanceof Error ? err.message : 'unexpected error' });
    try {
      const intent = intents.get(key);
      const replay = replayStored(intent);
      if (replay !== undefined) return { ...replay, replayed: false };
      // The provider may or may not have acted: leave it for status-based recovery and never claim either way.
      if (intent?.status === 'pending' || intent?.status === 'unknown') {
        intents.unknown(key);
        return { kind: 'unconfirmed', idempotency_key: key, checks: 0 };
      }
    } catch (recoveryErr) {
      log.error({ err: recoveryErr, userId, approvalId, idempotency_key: key }, 'recovery after failure failed');
    }
    return { kind: 'failed', code: 'internal', message: 'unexpected error' };
  }

  async function execute(userId: string, approvalId: string): Promise<ExecutionOutcome> {
    const approval = approvalsRepo.get(userId, approvalId);
    if (approval === undefined) return reject(userId, approvalId, 'approval_not_valid');
    const proposal = actionDeps.proposalsRepo.get(userId, approval.proposal_id);
    if (proposal === undefined) return reject(userId, approvalId, 'proposal_not_found');

    const key = idempotencyKey(proposal.action, approval.id);
    if (approval.status === 'consumed') {
      return replayStored(intents.get(key)) ?? reject(userId, approvalId, 'approval_already_consumed');
    }
    if (approval.status === 'void' || proposal.status !== 'approved' || approval.hash !== proposal.hash) {
      return reject(userId, approvalId, 'approval_not_valid');
    }

    try {
      let ready = proposal;
      if (proposal.action === 'book') {
        const prepared = await prepareBook(actionDeps, userId, approval.id, proposal);
        if ('outcome' in prepared) return prepared.outcome;
        ready = prepared.proposal;
      }

      if (!approvals.consume(userId, approval.id)) {
        return replayStored(intents.get(key)) ?? reject(userId, approvalId, 'approval_already_consumed');
      }
      const { intent, created } = intents.begin(userId, approval.id, proposal.action);
      if (!created) {
        const replay = replayStored(intent);
        if (replay !== undefined) return replay;
      }

      moveTo(actionDeps, userId, 'EXECUTING', `executing ${proposal.action}`);
      log.info({ userId, approvalId, idempotency_key: key, action: proposal.action }, 'executing');
      return await RUNNERS[proposal.action](actionDeps, { userId, approvalId: approval.id, key, proposal: ready });
    } catch (err) {
      return recoverFromUnexpected(userId, approvalId, key, err);
    }
  }

  return { execute };
}
