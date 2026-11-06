import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '@bellhop/shared/clock';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { ApprovalEvent } from '../../trace/types.js';
import type { TraceWriter } from '../../trace/writer.js';
import { newId } from '../ids.js';
import { createApprovalsRepo, createProposalsRepo, createTaskStateRepo } from '../repo/index.js';
import { canTransition, type StateMachine } from '../state/machine.js';
import { ApprovalSourceSchema, type Approval } from '../types.js';

type ApprovalEventOutcome = ApprovalEvent['outcome'];

/**
 * Invariant 1 (plan §7): approvals are created only here, only from what
 * the user confirmed (button / typed yes / MCP elicitation). Nothing in
 * this module reads a model output or a tool argument.
 */

export const ApproveInputSchema = z.object({
  proposal_id: z.string().min(1),
  hash: z.string().min(1),
  source: ApprovalSourceSchema,
});
export type ApproveInput = z.infer<typeof ApproveInputSchema>;

export type ApproveFailureReason = 'proposal_not_found' | 'proposal_not_pending' | 'hash_mismatch' | 'invalid_state';

export type ApproveResult = { ok: true; approval: Approval } | { ok: false; reason: ApproveFailureReason };

export interface ApprovalService {
  approve(userId: string, input: ApproveInput): ApproveResult;
  /** Compare-and-set `valid → consumed`; `true` only for the single caller that won. */
  consume(userId: string, approvalId: string): boolean;
  void(userId: string, approvalId: string, reason: string): boolean;
}

export interface ApprovalServiceDeps {
  db: Database.Database;
  clock: Clock;
  stateMachine: StateMachine;
  trace: TraceWriter;
  logger: Logger;
}

export function createApprovalService(deps: ApprovalServiceDeps): ApprovalService {
  const { db, clock, stateMachine, trace, logger } = deps;
  const log = childLogger(logger, 'approvals');
  const approvalsRepo = createApprovalsRepo(db);
  const proposalsRepo = createProposalsRepo(db);
  const taskStateRepo = createTaskStateRepo(db);

  function emit(approval: Approval, outcome: ApprovalEventOutcome): void {
    const proposal = proposalsRepo.get(approval.user_id, approval.proposal_id);
    trace.emit({
      type: 'approval',
      proposal_id: approval.proposal_id,
      approval_id: approval.id,
      action: proposal?.action ?? 'unknown',
      hash: approval.hash,
      outcome,
    });
  }

  return {
    approve(userId, rawInput) {
      const input = ApproveInputSchema.parse(rawInput);
      const proposal = proposalsRepo.get(userId, input.proposal_id);
      if (proposal === undefined) {
        log.warn({ userId, proposalId: input.proposal_id }, 'approve rejected: proposal not found');
        return { ok: false, reason: 'proposal_not_found' };
      }
      if (proposal.status !== 'pending') {
        log.warn({ userId, proposalId: proposal.id, status: proposal.status }, 'approve rejected: not pending');
        return { ok: false, reason: 'proposal_not_pending' };
      }
      if (input.hash !== proposal.hash) {
        log.warn({ userId, proposalId: proposal.id }, 'approve rejected: hash mismatch');
        trace.emit({
          type: 'approval',
          proposal_id: proposal.id,
          action: proposal.action,
          hash: input.hash,
          outcome: 'rejected',
        });
        return { ok: false, reason: 'hash_mismatch' };
      }
      const state = taskStateRepo.get(userId)?.state ?? 'GATHERING';
      if (state !== 'APPROVED' && !canTransition(state, 'APPROVED')) {
        log.warn({ userId, proposalId: proposal.id, state }, 'approve rejected: state cannot reach APPROVED');
        return { ok: false, reason: 'invalid_state' };
      }

      const now = clock.now().toISOString();
      const approval: Approval = {
        id: newId('appr'),
        proposal_id: proposal.id,
        user_id: userId,
        hash: proposal.hash,
        status: 'valid',
        source: input.source,
        created_at: now,
        consumed_at: null,
        void_reason: null,
      };
      const won = db.transaction(() => {
        if (!proposalsRepo.setStatusIf(userId, proposal.id, 'pending', 'approved', now)) return false;
        approvalsRepo.insert(approval);
        if (state !== 'APPROVED') stateMachine.transition(userId, 'APPROVED', `approved via ${input.source}`);
        return true;
      })();
      if (!won) {
        log.warn({ userId, proposalId: proposal.id }, 'approve lost the compare-and-set: proposal no longer pending');
        return { ok: false, reason: 'proposal_not_pending' };
      }
      emit(approval, 'created');
      log.info({ userId, proposalId: proposal.id, approvalId: approval.id, source: input.source }, 'approval created');
      return { ok: true, approval };
    },

    consume(userId, approvalId) {
      const approval = approvalsRepo.get(userId, approvalId);
      if (approval === undefined) return false;
      const consumed = approvalsRepo.consume(approvalId, clock.now().toISOString());
      if (consumed) {
        emit(approval, 'consumed');
        log.info({ userId, approvalId }, 'approval consumed');
      } else {
        log.warn({ userId, approvalId, status: approval.status }, 'approval consume lost the compare-and-set');
      }
      return consumed;
    },

    void(userId, approvalId, reason) {
      const approval = approvalsRepo.get(userId, approvalId);
      if (approval === undefined) return false;
      const voided = approvalsRepo.void(approvalId, reason);
      if (voided) {
        emit(approval, 'void');
        log.info({ userId, approvalId, reason }, 'approval void');
      }
      return voided;
    },
  };
}
