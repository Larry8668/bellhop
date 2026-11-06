import type Database from 'better-sqlite3';
import type { Currency, Service } from '@bellhop/shared/contracts';
import { ProposalSchema, type Action, type Proposal, type ProposalStatus } from '../types.js';

interface ProposalRow {
  id: string;
  user_id: string;
  action: Action;
  provider_id: string;
  provider_name: string;
  service: Service;
  slot_start: string;
  slot_end: string;
  price: number;
  currency: Currency;
  booking_id: string | null;
  hold_id: string | null;
  hold_expires_at: string | null;
  hash: string;
  status: ProposalStatus;
  created_at: string;
  updated_at: string;
}

function toDomain(row: ProposalRow): Proposal {
  return ProposalSchema.parse({
    id: row.id,
    user_id: row.user_id,
    action: row.action,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    service: row.service,
    slot: { start: row.slot_start, end: row.slot_end },
    price: row.price,
    currency: row.currency,
    booking_id: row.booking_id,
    hold_id: row.hold_id,
    hold_expires_at: row.hold_expires_at,
    hash: row.hash,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  });
}

export interface ProposalHoldUpdate {
  hold_id: string;
  hold_expires_at: string;
  price: number;
  hash: string;
}

export interface ProposalsRepo {
  insert(proposal: Proposal): void;
  get(userId: string, id: string): Proposal | undefined;
  listPending(userId: string): Proposal[];
  setStatus(userId: string, id: string, status: ProposalStatus, updatedAt: string): void;
  /** Compare-and-set: moves `from → to` only if the row is still `from`; `true` for the single caller that won. */
  setStatusIf(userId: string, id: string, from: ProposalStatus, to: ProposalStatus, updatedAt: string): boolean;
  /** Supersedes every pending proposal for `userId` except `exceptId` (plan §6: "a new proposal supersedes any pending one"). Returns the number of rows changed. */
  supersedePending(userId: string, exceptId: string, updatedAt: string): number;
  /** `updatedAt` is required (not in the plan's literal signature) because core never calls `Date.now()`; every write needs the caller's injected-clock timestamp. */
  updateHold(userId: string, id: string, hold: ProposalHoldUpdate, updatedAt: string): void;
}

export function createProposalsRepo(db: Database.Database): ProposalsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO proposals (
      id, user_id, action, provider_id, provider_name, service, slot_start, slot_end,
      price, currency, booking_id, hold_id, hold_expires_at, hash, status, created_at, updated_at
    ) VALUES (
      @id, @user_id, @action, @provider_id, @provider_name, @service, @slot_start, @slot_end,
      @price, @currency, @booking_id, @hold_id, @hold_expires_at, @hash, @status, @created_at, @updated_at
    )
  `);
  const selectStmt = db.prepare('SELECT * FROM proposals WHERE user_id = ? AND id = ?');
  const listPendingStmt = db.prepare(
    `SELECT * FROM proposals WHERE user_id = ? AND status = 'pending' ORDER BY created_at ASC`,
  );
  const setStatusStmt = db.prepare('UPDATE proposals SET status = ?, updated_at = ? WHERE user_id = ? AND id = ?');
  const setStatusIfStmt = db.prepare(
    'UPDATE proposals SET status = ?, updated_at = ? WHERE user_id = ? AND id = ? AND status = ?',
  );
  const supersedeStmt = db.prepare(
    `UPDATE proposals SET status = 'superseded', updated_at = ?
     WHERE user_id = ? AND status = 'pending' AND id != ?`,
  );
  const updateHoldStmt = db.prepare(
    `UPDATE proposals SET hold_id = ?, hold_expires_at = ?, price = ?, hash = ?, updated_at = ?
     WHERE user_id = ? AND id = ?`,
  );

  return {
    insert(proposal: Proposal): void {
      insertStmt.run({
        id: proposal.id,
        user_id: proposal.user_id,
        action: proposal.action,
        provider_id: proposal.provider_id,
        provider_name: proposal.provider_name,
        service: proposal.service,
        slot_start: proposal.slot.start,
        slot_end: proposal.slot.end,
        price: proposal.price,
        currency: proposal.currency,
        booking_id: proposal.booking_id,
        hold_id: proposal.hold_id,
        hold_expires_at: proposal.hold_expires_at,
        hash: proposal.hash,
        status: proposal.status,
        created_at: proposal.created_at,
        updated_at: proposal.updated_at,
      });
    },

    get(userId: string, id: string): Proposal | undefined {
      const row = selectStmt.get(userId, id) as ProposalRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },

    listPending(userId: string): Proposal[] {
      const rows = listPendingStmt.all(userId) as ProposalRow[];
      return rows.map(toDomain);
    },

    setStatus(userId: string, id: string, status: ProposalStatus, updatedAt: string): void {
      setStatusStmt.run(status, updatedAt, userId, id);
    },

    setStatusIf(userId: string, id: string, from: ProposalStatus, to: ProposalStatus, updatedAt: string): boolean {
      return setStatusIfStmt.run(to, updatedAt, userId, id, from).changes === 1;
    },

    supersedePending(userId: string, exceptId: string, updatedAt: string): number {
      const result = supersedeStmt.run(updatedAt, userId, exceptId);
      return result.changes;
    },

    updateHold(userId: string, id: string, hold: ProposalHoldUpdate, updatedAt: string): void {
      updateHoldStmt.run(hold.hold_id, hold.hold_expires_at, hold.price, hold.hash, updatedAt, userId, id);
    },
  };
}
