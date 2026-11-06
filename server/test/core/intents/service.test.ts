import { describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import { createIntentService, idempotencyKey, IntentNotFoundError } from '../../../src/core/intents/service.js';
import { createApprovalsRepo, createProposalsRepo } from '../../../src/core/repo/index.js';
import { createFakeTraceWriter } from '../../helpers/fake-trace.js';
import { makeApproval, makeProposal } from '../fixtures.js';
import { createTestDb, TEST_USER } from '../helpers.js';

/** `intents.approval_id` is a foreign key, so each test approval needs a real proposal + approval row. */
function seedApproval(db: ReturnType<typeof createTestDb>, approvalId: string): void {
  const proposal = makeProposal();
  createProposalsRepo(db).insert(proposal);
  createApprovalsRepo(db).insert(makeApproval({ id: approvalId, proposal_id: proposal.id, hash: proposal.hash }));
}

function setup() {
  const db = createTestDb();
  const clock = createFakeClock(Date.UTC(2026, 10, 6));
  const trace = createFakeTraceWriter();
  const intents = createIntentService({ db, clock, trace, logger: createLogger({ name: 't', level: 'silent' }) });
  seedApproval(db, 'appr_1');
  seedApproval(db, 'appr_2');
  return { db, clock, trace, intents };
}

describe('idempotencyKey', () => {
  it('derives the key from action + approval id (plan §8)', () => {
    expect(idempotencyKey('book', 'appr_1')).toBe('book_appr_1');
    expect(idempotencyKey('cancel', 'appr_1')).toBe('cancel_appr_1');
  });
});

describe('intent service', () => {
  it('S13 begin twice for the same approval returns the first row, created only once', () => {
    const { intents, trace } = setup();
    const first = intents.begin(TEST_USER, 'appr_1', 'book');
    const second = intents.begin(TEST_USER, 'appr_1', 'book');

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.intent).toEqual(first.intent);
    expect(first.intent).toMatchObject({ idempotency_key: 'book_appr_1', status: 'pending', attempts: 0 });
    expect(trace.events.filter((e) => e.type === 'intent')).toHaveLength(1);
  });

  it('every status change is persisted and traced; attempt() increments attempts', () => {
    const { intents, trace, clock } = setup();
    const { intent } = intents.begin(TEST_USER, 'appr_2', 'cancel');
    const key = intent.idempotency_key;

    expect(intents.attempt(key).attempts).toBe(1);
    expect(intents.attempt(key).attempts).toBe(2);
    clock.advance(1_000);
    expect(intents.unknown(key).status).toBe('unknown');
    const done = intents.succeed(key, { kind: 'cancelled' });
    expect(done).toMatchObject({ status: 'succeeded', result: { kind: 'cancelled' }, attempts: 2 });
    expect(intents.fail(key, { code: 'x' }).status).toBe('failed');

    expect(trace.events.filter((e) => e.type === 'intent').map((e) => ('status' in e ? e.status : null))).toEqual([
      'pending',
      'unknown',
      'succeeded',
      'failed',
    ]);
    expect(trace.events[1]).toMatchObject({ type: 'intent', idempotency_key: key, action: 'cancel' });
  });

  it('status change on an unknown key throws instead of silently doing nothing', () => {
    const { intents } = setup();
    expect(() => intents.succeed('book_missing', {})).toThrow(IntentNotFoundError);
  });
});
