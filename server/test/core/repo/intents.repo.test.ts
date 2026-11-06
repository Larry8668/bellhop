import { describe, expect, it } from 'vitest';
import { createApprovalsRepo } from '../../../src/core/repo/approvals.repo.js';
import { createIntentsRepo, type NewIntent } from '../../../src/core/repo/intents.repo.js';
import { createProposalsRepo } from '../../../src/core/repo/proposals.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';
import { makeApproval, makeProposal } from '../fixtures.js';

/** Seeds a proposal + valid approval so `intents.approval_id` satisfies the FK. */
function seedApproval(db: ReturnType<typeof createTestDb>) {
  const proposal = makeProposal();
  createProposalsRepo(db).insert(proposal);
  const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash });
  createApprovalsRepo(db).insert(approval);
  return approval;
}

function newIntentFor(approvalId: string, overrides: Partial<NewIntent> = {}): NewIntent {
  return {
    idempotency_key: `book_${approvalId}`,
    approval_id: approvalId,
    user_id: TEST_USER,
    action: 'book',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('intentsRepo', () => {
  it('insertPending creates a pending row, and a second call for the same key returns created: false without changing it', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);
    const intent = newIntentFor(approval.id);

    expect(repo.insertPending(intent)).toEqual({ created: true });
    expect(repo.get(intent.idempotency_key)).toMatchObject({ status: 'pending', attempts: 0 });

    // Mutate the row, then try to insert "the same" intent again under the same key.
    repo.incrementAttempts(intent.idempotency_key, '2026-01-01T00:01:00Z');
    expect(repo.insertPending(intent)).toEqual({ created: false });

    const after = repo.get(intent.idempotency_key);
    expect(after?.attempts).toBe(1); // left intact, not reset by the ignored insert
  });

  it('cross-user get is not filtered here (keyed by idempotency_key), but listByUser is scoped', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);
    repo.insertPending(newIntentFor(approval.id));

    expect(repo.listByUser(OTHER_USER)).toEqual([]);
    expect(repo.listByUser(TEST_USER)).toHaveLength(1);
  });

  it('setStatus updates status, result, and updated_at', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);
    const intent = newIntentFor(approval.id);
    repo.insertPending(intent);

    repo.setStatus(intent.idempotency_key, 'succeeded', '2026-01-01T00:02:00Z', { booking_id: 'bk_1' });

    expect(repo.get(intent.idempotency_key)).toMatchObject({
      status: 'succeeded',
      result: { booking_id: 'bk_1' },
      updated_at: '2026-01-01T00:02:00Z',
    });
  });

  it('setStatus without a result leaves result_json unchanged', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);
    const intent = newIntentFor(approval.id);
    repo.insertPending(intent);
    repo.setStatus(intent.idempotency_key, 'succeeded', '2026-01-01T00:02:00Z', { ok: true });

    repo.setStatus(intent.idempotency_key, 'unknown', '2026-01-01T00:03:00Z');

    expect(repo.get(intent.idempotency_key)).toMatchObject({ status: 'unknown', result: { ok: true } });
  });

  it('incrementAttempts bumps attempts by one and updates updated_at', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);
    const intent = newIntentFor(approval.id);
    repo.insertPending(intent);

    repo.incrementAttempts(intent.idempotency_key, '2026-01-01T00:01:00Z');
    repo.incrementAttempts(intent.idempotency_key, '2026-01-01T00:02:00Z');

    expect(repo.get(intent.idempotency_key)).toMatchObject({ attempts: 2, updated_at: '2026-01-01T00:02:00Z' });
  });

  it('listUnresolved returns pending/unknown intents across all users, excluding succeeded/failed', () => {
    const db = createTestDb();
    const approval = seedApproval(db);
    const repo = createIntentsRepo(db);

    const pending = newIntentFor(approval.id, { idempotency_key: 'book_1' });
    const unknown = newIntentFor(approval.id, { idempotency_key: 'book_2', user_id: OTHER_USER });
    const succeeded = newIntentFor(approval.id, { idempotency_key: 'book_3' });

    repo.insertPending(pending);
    repo.insertPending(unknown);
    repo.insertPending(succeeded);
    repo.setStatus(unknown.idempotency_key, 'unknown', '2026-01-01T00:01:00Z');
    repo.setStatus(succeeded.idempotency_key, 'succeeded', '2026-01-01T00:01:00Z');

    const unresolved = repo.listUnresolved();
    expect(unresolved.map((i) => i.idempotency_key).sort()).toEqual(['book_1', 'book_2']);
  });
});
