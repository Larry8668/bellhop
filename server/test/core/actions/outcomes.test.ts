import { describe, expect, it } from 'vitest';
import {
  describeOutcome,
  ExecutionOutcomeSchema,
  isSuccessOutcome,
  type ExecutionOutcome,
} from '../../../src/core/actions/outcomes.js';
import { makeAppBooking, makeProposal } from '../fixtures.js';

const slot = { start: '2026-11-07T10:00:00+05:30', end: '2026-11-07T11:00:00+05:30' };

const ALL: ExecutionOutcome[] = [
  { kind: 'booked', booking: makeAppBooking(), replayed: false },
  { kind: 'cancelled', booking: makeAppBooking({ status: 'cancelled' }), replayed: true },
  { kind: 'rescheduled', booking: makeAppBooking({ status: 'rescheduled' }), previous_slot: slot, replayed: false },
  { kind: 'needs_reapproval', proposal: makeProposal({ price: 650 }), previous_price: 500, new_price: 650 },
  { kind: 'slot_gone', reason: 'slot_conflict', alternatives: [slot] },
  { kind: 'unconfirmed', idempotency_key: 'book_appr_1', checks: 3 },
  { kind: 'rejected', reason: 'approval_not_valid' },
  { kind: 'failed', code: 'internal', message: 'boom' },
];

describe('ExecutionOutcome', () => {
  it('every kind round-trips through the zod schema and has a non-empty sentence', () => {
    for (const outcome of ALL) {
      expect(ExecutionOutcomeSchema.parse(outcome)).toEqual(outcome);
      expect(describeOutcome(outcome).length).toBeGreaterThan(10);
    }
  });

  it('only booked / cancelled / rescheduled count as success', () => {
    expect(ALL.filter(isSuccessOutcome).map((o) => o.kind)).toEqual(['booked', 'cancelled', 'rescheduled']);
  });

  it('S15 unconfirmed says unconfirmed and checking, never success', () => {
    const text = describeOutcome({ kind: 'unconfirmed', idempotency_key: 'k', checks: 3 });
    expect(text).toMatch(/unconfirmed/);
    expect(text).toMatch(/checking/);
    expect(text).not.toMatch(/\bbooked\b|\bconfirmed\b|\bdone\b|\bsuccess/i);
  });

  it('slot_gone lists the alternatives; needs_reapproval names both prices', () => {
    expect(describeOutcome(ALL[4]!)).toContain(slot.start);
    expect(describeOutcome(ALL[3]!)).toMatch(/₹500.*₹650/);
  });
});
