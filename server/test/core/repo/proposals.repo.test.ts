import { describe, expect, it } from 'vitest';
import { createProposalsRepo } from '../../../src/core/repo/proposals.repo.js';
import { createTestDb, OTHER_USER, TEST_USER } from '../helpers.js';
import { makeProposal } from '../fixtures.js';

describe('proposalsRepo', () => {
  it('round-trips insert -> get, mapping slot_start/slot_end to a slot object', () => {
    const repo = createProposalsRepo(createTestDb());
    const proposal = makeProposal();

    repo.insert(proposal);
    expect(repo.get(TEST_USER, proposal.id)).toEqual(proposal);
  });

  it('cross-user get returns undefined even for a valid id', () => {
    const repo = createProposalsRepo(createTestDb());
    const proposal = makeProposal();
    repo.insert(proposal);

    expect(repo.get(OTHER_USER, proposal.id)).toBeUndefined();
  });

  it('listPending returns only pending proposals for that user', () => {
    const repo = createProposalsRepo(createTestDb());
    const pending = makeProposal({ status: 'pending' });
    const declined = makeProposal({ status: 'declined' });
    const otherUsersPending = makeProposal({ user_id: OTHER_USER, status: 'pending' });

    repo.insert(pending);
    repo.insert(declined);
    repo.insert(otherUsersPending);

    const result = repo.listPending(TEST_USER);
    expect(result.map((p) => p.id)).toEqual([pending.id]);
  });

  it('setStatusIf is a compare-and-set: only the first pending → approved wins, and it is user-scoped', () => {
    const repo = createProposalsRepo(createTestDb());
    const proposal = makeProposal({ status: 'pending' });
    repo.insert(proposal);
    const at = '2026-01-01T00:05:00Z';

    expect(repo.setStatusIf(OTHER_USER, proposal.id, 'pending', 'approved', at)).toBe(false);
    expect(repo.setStatusIf(TEST_USER, proposal.id, 'pending', 'approved', at)).toBe(true);
    expect(repo.setStatusIf(TEST_USER, proposal.id, 'pending', 'approved', at)).toBe(false);
    expect(repo.get(TEST_USER, proposal.id)).toMatchObject({ status: 'approved', updated_at: at });
  });

  it('setStatus updates status and updated_at', () => {
    const repo = createProposalsRepo(createTestDb());
    const proposal = makeProposal();
    repo.insert(proposal);

    repo.setStatus(TEST_USER, proposal.id, 'declined', '2026-01-02T00:00:00Z');

    const updated = repo.get(TEST_USER, proposal.id);
    expect(updated?.status).toBe('declined');
    expect(updated?.updated_at).toBe('2026-01-02T00:00:00Z');
  });

  it('supersedePending supersedes every other pending proposal for the user, returning the count changed', () => {
    const repo = createProposalsRepo(createTestDb());
    const first = makeProposal({ status: 'pending' });
    const second = makeProposal({ status: 'pending' });
    const third = makeProposal({ status: 'pending' });
    const otherUsers = makeProposal({ user_id: OTHER_USER, status: 'pending' });

    repo.insert(first);
    repo.insert(second);
    repo.insert(third);
    repo.insert(otherUsers);

    const changed = repo.supersedePending(TEST_USER, third.id, '2026-01-02T00:00:00Z');

    expect(changed).toBe(2);
    expect(repo.get(TEST_USER, first.id)?.status).toBe('superseded');
    expect(repo.get(TEST_USER, second.id)?.status).toBe('superseded');
    expect(repo.get(TEST_USER, third.id)?.status).toBe('pending');
    expect(repo.get(OTHER_USER, otherUsers.id)?.status).toBe('pending');
  });

  it('updateHold rewrites hold_id, hold_expires_at, price, and hash', () => {
    const repo = createProposalsRepo(createTestDb());
    const proposal = makeProposal();
    repo.insert(proposal);

    repo.updateHold(
      TEST_USER,
      proposal.id,
      { hold_id: 'hold_2', hold_expires_at: '2026-01-01T01:00:00Z', price: 600, hash: 'new_hash' },
      '2026-01-01T00:20:00Z',
    );

    const updated = repo.get(TEST_USER, proposal.id);
    expect(updated).toMatchObject({
      hold_id: 'hold_2',
      hold_expires_at: '2026-01-01T01:00:00Z',
      price: 600,
      hash: 'new_hash',
      updated_at: '2026-01-01T00:20:00Z',
    });
  });
});
