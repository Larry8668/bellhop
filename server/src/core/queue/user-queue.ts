import { childLogger, type Logger } from '@bellhop/shared/logger';

export interface UserQueue {
  /**
   * Chains `fn` behind every previously queued task for `userId`, so a user
   * turn and a background event never interleave (plan §8). Independent
   * users never block each other. A rejected task settles the queue's
   * internal chain anyway — it is returned to this call's caller, but the
   * next queued task for the same user still runs.
   */
  run<T>(userId: string, label: string, fn: () => Promise<T>): Promise<T>;
  /** Number of tasks for `userId` queued or currently running. */
  size(userId: string): number;
}

interface QueueEntry {
  /** Always settles (never rejects) so the next task can chain off it unconditionally. */
  tail: Promise<void>;
  pending: number;
}

function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}

/**
 * Per-user FIFO promise queue (plan §8, §12). No process locks: ordering
 * comes entirely from chaining promises synchronously inside `run`, before
 * `fn` is ever invoked. Entries are deleted once drained so the map never
 * grows with users who are no longer active.
 */
export function createUserQueue({ logger }: { logger: Logger }): UserQueue {
  const log = childLogger(logger, 'user-queue');
  const entries = new Map<string, QueueEntry>();

  function size(userId: string): number {
    return entries.get(userId)?.pending ?? 0;
  }

  function run<T>(userId: string, label: string, fn: () => Promise<T>): Promise<T> {
    const entry = entries.get(userId) ?? { tail: Promise.resolve(), pending: 0 };
    entry.pending += 1;
    entries.set(userId, entry);

    const previousTail = entry.tail;
    const result = previousTail.then(() => {
      log.debug({ userId, label }, 'user-queue: task start');
      return fn();
    });

    // The chain itself must never reject, or the next queued task would
    // never run; the rejection below still reaches this call's own caller.
    entry.tail = settle(result);

    result.then(
      () => {
        log.debug({ userId, label }, 'user-queue: task done');
      },
      (err: unknown) => {
        log.warn({ err, userId, label }, 'user-queue: task failed, next task unaffected');
      },
    );

    const cleanup = (): void => {
      const current = entries.get(userId);
      if (current === undefined) return;
      current.pending -= 1;
      if (current.pending === 0) {
        entries.delete(userId);
      }
    };
    result.then(cleanup, cleanup);

    return result;
  }

  return { run, size };
}
