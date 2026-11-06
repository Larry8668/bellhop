import { newId } from '../../src/core/ids.js';
import { proposalHash } from '../../src/core/approvals/hash.js';
import type { Approval, AppBooking, Intent, Proposal } from '../../src/core/types.js';
import { TEST_USER } from './helpers.js';

const NOW = '2026-01-01T00:00:00Z';

export function makeProposal(overrides: Partial<Proposal> = {}): Proposal {
  const base: Proposal = {
    id: newId('prop'),
    user_id: TEST_USER,
    action: 'book',
    provider_id: 'prv_1',
    provider_name: 'Ravi Plumbing',
    service: 'plumber',
    slot: { start: '2026-01-10T04:00:00Z', end: '2026-01-10T05:00:00Z' },
    price: 500,
    currency: 'INR',
    booking_id: null,
    hold_id: 'hold_1',
    hold_expires_at: '2026-01-01T00:10:00Z',
    hash: '',
    status: 'pending',
    created_at: NOW,
    updated_at: NOW,
  };
  const merged = { ...base, ...overrides };
  if (merged.hash === '') {
    merged.hash = proposalHash({
      action: merged.action,
      provider_id: merged.provider_id,
      slot: merged.slot,
      price: merged.price,
      booking_id: merged.booking_id,
    });
  }
  return merged;
}

export function makeApproval(overrides: Partial<Approval> = {}): Approval {
  return {
    id: newId('appr'),
    proposal_id: 'prop_placeholder',
    user_id: TEST_USER,
    hash: 'hash_placeholder',
    status: 'valid',
    source: 'button',
    created_at: NOW,
    consumed_at: null,
    void_reason: null,
    ...overrides,
  };
}

export function makeIntent(overrides: Partial<Intent> = {}): Intent {
  return {
    idempotency_key: `book_${newId('appr')}`,
    approval_id: 'appr_placeholder',
    user_id: TEST_USER,
    action: 'book',
    status: 'pending',
    result: null,
    attempts: 0,
    created_at: NOW,
    updated_at: NOW,
    ...overrides,
  };
}

export function makeAppBooking(overrides: Partial<AppBooking> = {}): AppBooking {
  return {
    booking_id: newId('bk'),
    user_id: TEST_USER,
    provider_id: 'prv_1',
    provider_name: 'Ravi Plumbing',
    service: 'plumber',
    slot: { start: '2026-01-10T04:00:00Z', end: '2026-01-10T05:00:00Z' },
    price: 500,
    currency: 'INR',
    status: 'confirmed',
    synced_at: NOW,
    ...overrides,
  };
}
