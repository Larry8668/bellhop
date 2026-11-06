export interface Rng {
  /** Uniform in [0, 1). */
  next(): number;
  int(minInclusive: number, maxExclusive: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

/** Mulberry32 — deterministic PRNG for tests and provider seeding. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function createSeededRng(seed: number): Rng {
  const nextFn = mulberry32(seed >>> 0);

  return {
    next(): number {
      return nextFn();
    },
    int(minInclusive: number, maxExclusive: number): number {
      if (maxExclusive <= minInclusive) {
        throw new RangeError('maxExclusive must be greater than minInclusive');
      }
      const span = maxExclusive - minInclusive;
      return minInclusive + Math.floor(nextFn() * span);
    },
    pick<T>(items: readonly T[]): T {
      if (items.length === 0) {
        throw new RangeError('pick: items must not be empty');
      }
      const i = Math.floor(nextFn() * items.length);
      const item = items[i];
      if (item === undefined) {
        throw new Error('pick: index out of range');
      }
      return item;
    },
    chance(p: number): boolean {
      return nextFn() < p;
    },
  };
}

export const systemRng: Rng = {
  next(): number {
    return Math.random();
  },
  int(minInclusive: number, maxExclusive: number): number {
    if (maxExclusive <= minInclusive) {
      throw new RangeError('maxExclusive must be greater than minInclusive');
    }
    const span = maxExclusive - minInclusive;
    return minInclusive + Math.floor(Math.random() * span);
  },
  pick<T>(items: readonly T[]): T {
    if (items.length === 0) {
      throw new RangeError('pick: items must not be empty');
    }
    const i = Math.floor(Math.random() * items.length);
    const item = items[i];
    if (item === undefined) {
      throw new Error('pick: index out of range');
    }
    return item;
  },
  chance(p: number): boolean {
    return Math.random() < p;
  },
};
