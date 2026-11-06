export interface Clock {
  now(): Date;
  nowMs(): number;
}

export const systemClock: Clock = {
  now(): Date {
    return new Date();
  },
  nowMs(): number {
    return Date.now();
  },
};

export interface FakeClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function createFakeClock(startMs: number): FakeClock {
  let t = startMs;
  return {
    now(): Date {
      return new Date(t);
    },
    nowMs(): number {
      return t;
    },
    set(ms: number): void {
      t = ms;
    },
    advance(ms: number): void {
      t += ms;
    },
  };
}
