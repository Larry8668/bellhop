import type { Clock } from '@bellhop/shared/clock';

/**
 * A clock the admin routes can set/advance at runtime (hold-expiry tests,
 * `POST /__admin/clock`), implemented as an offset over a `base` clock.
 * In prod `base` is `systemClock`; tests can pass a fake clock as `base`
 * and still exercise `set`/`advance` the same way the HTTP layer does.
 */
export interface AdjustableClock extends Clock {
  set(ms: number): void;
  advance(ms: number): void;
}

export function createAdjustableClock(base: Clock): AdjustableClock {
  let offsetMs = 0;

  return {
    now(): Date {
      return new Date(base.nowMs() + offsetMs);
    },
    nowMs(): number {
      return base.nowMs() + offsetMs;
    },
    set(ms: number): void {
      offsetMs = ms - base.nowMs();
    },
    advance(ms: number): void {
      offsetMs += ms;
    },
  };
}
