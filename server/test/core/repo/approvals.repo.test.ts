import { describe, expect, it } from 'vitest';
import { createApprovalsRepo } from '../../../src/core/repo/approvals.repo.js';
import { createProposalsRepo } from '../../../src/core/repo/proposals.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';
import { makeApproval, makeProposal } from '../fixtures.js';

describe('approvalsRepo', () => {
  it('round-trips insert -> get', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash });
    repo.insert(approval);

    expect(repo.get(TEST_USER, approval.id)).toEqual(approval);
  });

  it('cross-user get returns undefined', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash });
    repo.insert(approval);

    expect(repo.get(OTHER_USER, approval.id)).toBeUndefined();
  });

  it('getValidForProposal finds the valid approval for that proposal and user only', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const valid = makeApproval({ proposal_id: proposal.id, hash: proposal.hash, status: 'valid' });
    repo.insert(valid);

    expect(repo.getValidForProposal(TEST_USER, proposal.id)?.id).toBe(valid.id);
    expect(repo.getValidForProposal(OTHER_USER, proposal.id)).toBeUndefined();
  });

  it('getValidForProposal does not return a void or consumed approval', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    repo.insert(makeApproval({ proposal_id: proposal.id, hash: proposal.hash, status: 'void' }));

    expect(repo.getValidForProposal(TEST_USER, proposal.id)).toBeUndefined();
  });

  it('consume returns true exactly once, then false for a repeated call (CAS)', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash, status: 'valid' });
    repo.insert(approval);

    expect(repo.consume(approval.id, '2026-01-01T00:05:00Z')).toBe(true);
    expect(repo.get(TEST_USER, approval.id)?.status).toBe('consumed');

    // Second confirmation / replay must not re-consume.
    expect(repo.consume(approval.id, '2026-01-01T00:06:00Z')).toBe(false);
    expect(repo.get(TEST_USER, approval.id)?.consumed_at).toBe('2026-01-01T00:05:00Z');
  });

  it('void returns true exactly once from valid, then false', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash, status: 'valid' });
    repo.insert(approval);

    expect(repo.void(approval.id, 'hash mismatch at execute time')).toBe(true);
    expect(repo.get(TEST_USER, approval.id)).toMatchObject({
      status: 'void',
      void_reason: 'hash mismatch at execute time',
    });
    expect(repo.void(approval.id, 'second attempt')).toBe(false);
  });

  it('consume on an already-void approval returns false', () => {
    const db = createTestDb();
    const proposal = makeProposal();
    createProposalsRepo(db).insert(proposal);

    const repo = createApprovalsRepo(db);
    const approval = makeApproval({ proposal_id: proposal.id, hash: proposal.hash, status: 'valid' });
    repo.insert(approval);
    repo.void(approval.id, 'material change');

    expect(repo.consume(approval.id, '2026-01-01T00:10:00Z')).toBe(false);
  });
});
