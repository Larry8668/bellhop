import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ProviderSummary } from '@bellhop/shared/contracts';
import { createApprovalsRepo, createProposalsRepo } from '../../../src/core/repo/index.js';
import { OTHER_USER, TEST_USER } from '../helpers.js';
import { findProvider, proposeBooking, startEngineHarness, type EngineHarness } from '../engine-harness.js';

describe('approval service', () => {
  let h: EngineHarness;
  let provider: ProviderSummary;

  beforeEach(async () => {
    h = await startEngineHarness();
    provider = await findProvider(h);
  });
  afterEach(async () => {
    await h.close();
  });

  it('approve with the exact card hash creates a valid approval, marks the proposal approved, traces, → APPROVED', async () => {
    const proposal = await proposeBooking(h, provider);
    const result = h.approvals.approve(TEST_USER, { proposal_id: proposal.id, hash: proposal.hash, source: 'button' });
    if (!result.ok) throw new Error(result.reason);

    expect(result.approval).toMatchObject({ proposal_id: proposal.id, hash: proposal.hash, status: 'valid' });
    expect(createProposalsRepo(h.db).get(TEST_USER, proposal.id)?.status).toBe('approved');
    expect(h.state()).toBe('APPROVED');
    expect(h.trace.events.filter((e) => e.type === 'approval')).toEqual([
      expect.objectContaining({ outcome: 'created', approval_id: result.approval.id, action: 'book' }),
    ]);
  });

  it('hash_mismatch is rejected, traced, and creates no approval', async () => {
    const proposal = await proposeBooking(h, provider);
    const tampered = proposal.hash.replace(/^./, (c) => (c === 'a' ? 'b' : 'a'));
    const result = h.approvals.approve(TEST_USER, { proposal_id: proposal.id, hash: tampered, source: 'typed' });

    expect(result).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(h.trace.events.filter((e) => e.type === 'approval')).toEqual([
      expect.objectContaining({ outcome: 'rejected', proposal_id: proposal.id }),
    ]);
    expect(createApprovalsRepo(h.db).getValidForProposal(TEST_USER, proposal.id)).toBeUndefined();
    expect(createProposalsRepo(h.db).get(TEST_USER, proposal.id)?.status).toBe('pending');
    expect(h.state()).toBe('PROPOSED');
  });

  it('unknown proposal and another user’s proposal → proposal_not_found', async () => {
    const proposal = await proposeBooking(h, provider);
    expect(h.approvals.approve(TEST_USER, { proposal_id: 'prop_nope', hash: proposal.hash, source: 'button' })).toEqual(
      { ok: false, reason: 'proposal_not_found' },
    );
    expect(
      h.approvals.approve(OTHER_USER, { proposal_id: proposal.id, hash: proposal.hash, source: 'button' }),
    ).toEqual({ ok: false, reason: 'proposal_not_found' });
  });

  it('approving the same proposal twice → second is proposal_not_pending', async () => {
    const proposal = await proposeBooking(h, provider);
    const input = { proposal_id: proposal.id, hash: proposal.hash, source: 'button' as const };
    expect(h.approvals.approve(TEST_USER, input).ok).toBe(true);
    expect(h.approvals.approve(TEST_USER, input)).toEqual({ ok: false, reason: 'proposal_not_pending' });
  });

  it('two concurrent approves → one ok, one proposal_not_pending, exactly one approval row', async () => {
    const proposal = await proposeBooking(h, provider);
    const input = { proposal_id: proposal.id, hash: proposal.hash, source: 'button' as const };

    const results = await Promise.all([
      Promise.resolve().then(() => h.approvals.approve(TEST_USER, input)),
      Promise.resolve().then(() => h.approvals.approve(TEST_USER, input)),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, reason: 'proposal_not_pending' }]);
    const rows = h.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE proposal_id = ?').get(proposal.id) as {
      n: number;
    };
    expect(rows.n).toBe(1);
  });

  it('double consume → only the first wins; consume and void are user-scoped and traced', async () => {
    const proposal = await proposeBooking(h, provider);
    const result = h.approvals.approve(TEST_USER, { proposal_id: proposal.id, hash: proposal.hash, source: 'button' });
    if (!result.ok) throw new Error(result.reason);
    const id = result.approval.id;

    expect(h.approvals.consume(OTHER_USER, id)).toBe(false);
    expect(h.approvals.consume(TEST_USER, id)).toBe(true);
    expect(h.approvals.consume(TEST_USER, id)).toBe(false);
    expect(h.approvals.void(TEST_USER, id, 'late')).toBe(false);

    const outcomes = h.trace.events.flatMap((e) => (e.type === 'approval' ? [e.outcome] : []));
    expect(outcomes).toEqual(['created', 'consumed']);
  });

  it('void turns a valid approval void with a reason', async () => {
    const proposal = await proposeBooking(h, provider);
    const result = h.approvals.approve(TEST_USER, { proposal_id: proposal.id, hash: proposal.hash, source: 'button' });
    if (!result.ok) throw new Error(result.reason);

    expect(h.approvals.void(TEST_USER, result.approval.id, 'price_changed')).toBe(true);
    expect(createApprovalsRepo(h.db).get(TEST_USER, result.approval.id)).toMatchObject({
      status: 'void',
      void_reason: 'price_changed',
    });
    expect(h.approvals.consume(TEST_USER, result.approval.id)).toBe(false);
  });
});
