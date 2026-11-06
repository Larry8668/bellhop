import { describe, expect, it } from 'vitest';
import { createSeededRng } from '../src/rng.js';

describe('createSeededRng', () => {
  it('is deterministic for the same seed', () => {
    const a = createSeededRng(42);
    const b = createSeededRng(42);
    for (let i = 0; i < 20; i++) {
      expect(a.next()).toBe(b.next());
    }
  });

  it('int stays within [min, max) over many draws', () => {
    const rng = createSeededRng(99);
    for (let i = 0; i < 1000; i++) {
      const v = rng.int(-10, 10);
      expect(v).toBeGreaterThanOrEqual(-10);
      expect(v).toBeLessThan(10);
    }
  });

  it('pick returns only members of the list', () => {
    const rng = createSeededRng(7);
    const items = ['a', 'b', 'c', 'd'] as const;
    for (let i = 0; i < 200; i++) {
      expect(items).toContain(rng.pick(items));
    }
  });
});
