import { describe, expect, it } from 'vitest';
import { canonicalJson, proposalHash, type ProposalHashInput } from '../../src/core/approvals/hash.js';

const BASE: ProposalHashInput = {
  action: 'book',
  provider_id: 'prv_1',
  slot: { start: '2026-11-10T04:00:00Z', end: '2026-11-10T05:00:00Z' },
  price: 500,
  booking_id: null,
};

describe('canonicalJson', () => {
  it('sorts keys so object key order does not affect the string', () => {
    const a = canonicalJson({ b: 2, a: 1 });
    const b = canonicalJson({ a: 1, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":1,"b":2}');
  });

  it('has no whitespace', () => {
    expect(canonicalJson({ a: [1, 2], b: 'x' })).toBe('{"a":[1,2],"b":"x"}');
  });
});

describe('proposalHash', () => {
  it('is stable across key order in the slot object', () => {
    const h1 = proposalHash(BASE);
    const h2 = proposalHash({
      ...BASE,
      slot: { end: BASE.slot.end, start: BASE.slot.start },
    });
    expect(h1).toBe(h2);
  });

  it('produces identical hashes for identical inputs', () => {
    expect(proposalHash(BASE)).toBe(proposalHash({ ...BASE }));
  });

  it('is a sha256 hex digest', () => {
    expect(proposalHash(BASE)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('changes when price changes', () => {
    expect(proposalHash(BASE)).not.toBe(proposalHash({ ...BASE, price: 600 }));
  });

  it('changes when the slot changes', () => {
    expect(proposalHash(BASE)).not.toBe(
      proposalHash({ ...BASE, slot: { start: '2026-11-11T04:00:00Z', end: '2026-11-11T05:00:00Z' } }),
    );
  });

  it('changes when provider_id changes', () => {
    expect(proposalHash(BASE)).not.toBe(proposalHash({ ...BASE, provider_id: 'prv_2' }));
  });

  it('changes when action changes', () => {
    expect(proposalHash(BASE)).not.toBe(proposalHash({ ...BASE, action: 'cancel' }));
  });

  it('changes when booking_id changes', () => {
    expect(proposalHash(BASE)).not.toBe(proposalHash({ ...BASE, booking_id: 'bk_1' }));
  });
});
