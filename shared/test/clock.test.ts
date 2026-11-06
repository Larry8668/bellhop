import { describe, expect, it } from 'vitest';
import { createFakeClock } from '../src/clock.js';

describe('FakeClock', () => {
  it('set moves absolute time', () => {
    const clock = createFakeClock(1_000);
    expect(clock.nowMs()).toBe(1_000);
    clock.set(5_000);
    expect(clock.nowMs()).toBe(5_000);
    expect(clock.now().getTime()).toBe(5_000);
  });

  it('advance moves time forward', () => {
    const clock = createFakeClock(100);
    clock.advance(50);
    expect(clock.nowMs()).toBe(150);
  });
});
