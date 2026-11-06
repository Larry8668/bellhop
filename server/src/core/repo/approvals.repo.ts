import type Database from 'better-sqlite3';
import { ApprovalSchema, type Approval, type ApprovalSource, type ApprovalStatus } from '../types.js';

interface ApprovalRow {
  id: string;
  proposal_id: string;
  user_id: string;
  hash: string;
  status: ApprovalStatus;
  source: ApprovalSource;
  created_at: string;
  consumed_at: string | null;
  void_reason: string | null;
}

function toDomain(row: ApprovalRow): Approval {
  return ApprovalSchema.parse(row);
}

export interface ApprovalsRepo {
  insert(approval: Approval): void;
  get(userId: string, id: string): Approval | undefined;
  getValidForProposal(userId: string, proposalId: string): Approval | undefined;
  /**
   * Atomic consume (plan §7): `UPDATE … WHERE id = ? AND status = 'valid'`,
   * `true` only if exactly one row changed. The compare-and-set is the
   * entire safety mechanism — no process locks — so a repeated confirmation
   * or a replayed request can consume the same approval at most once.
   */
  consume(id: string, consumedAt: string): boolean;
  /** Same CAS pattern, from `'valid'` to `'void'` (material change / hash mismatch at execute time). */
  void(id: string, reason: string): boolean;
}

export function createApprovalsRepo(db: Database.Database): ApprovalsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO approvals (id, proposal_id, user_id, hash, status, source, created_at, consumed_at, void_reason)
    VALUES (@id, @proposal_id, @user_id, @hash, @status, @source, @created_at, @consumed_at, @void_reason)
  `);
  const selectStmt = db.prepare('SELECT * FROM approvals WHERE user_id = ? AND id = ?');
  const selectValidForProposalStmt = db.prepare(
    `SELECT * FROM approvals WHERE user_id = ? AND proposal_id = ? AND status = 'valid' ORDER BY created_at DESC LIMIT 1`,
  );
  const consumeStmt = db.prepare(`UPDATE approvals SET status='consumed', consumed_at=? WHERE id=? AND status='valid'`);
  const voidStmt = db.prepare(`UPDATE approvals SET status='void', void_reason=? WHERE id=? AND status='valid'`);

  return {
    insert(approval: Approval): void {
      insertStmt.run({
        id: approval.id,
        proposal_id: approval.proposal_id,
        user_id: approval.user_id,
        hash: approval.hash,
        status: approval.status,
        source: approval.source,
        created_at: approval.created_at,
        consumed_at: approval.consumed_at,
        void_reason: approval.void_reason,
      });
    },

    get(userId: string, id: string): Approval | undefined {
      const row = selectStmt.get(userId, id) as ApprovalRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },

    getValidForProposal(userId: string, proposalId: string): Approval | undefined {
      const row = selectValidForProposalStmt.get(userId, proposalId) as ApprovalRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },

    consume(id: string, consumedAt: string): boolean {
      const result = consumeStmt.run(consumedAt, id);
      return result.changes === 1;
    },

    void(id: string, reason: string): boolean {
      const result = voidStmt.run(reason, id);
      return result.changes === 1;
    },
  };
}
