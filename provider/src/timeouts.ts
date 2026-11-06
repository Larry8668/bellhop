/** Mutable delay used by the `book` route's simulated timeout (plan §4). */
export interface TimeoutControl {
  getDelayMs(): number;
  setDelayMs(ms: number): void;
}

export function createTimeoutControl(initialMs: number): TimeoutControl {
  let delayMs = initialMs;
  return {
    getDelayMs(): number {
      return delayMs;
    },
    setDelayMs(ms: number): void {
      delayMs = ms;
    },
  };
}
