import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../provider-client/client.js';
import type { UserQueue } from '../core/queue/user-queue.js';
import { pollBookings, startPoller } from './poller.js';
import { processEvents, type ProcessorDeps, type ProactiveNotice } from './processor.js';
import type { Preference } from './replacements.js';

export { pollBookings, startPoller, PROVIDER_CANCELLED, type PollerDeps, type StartPollerOpts } from './poller.js';
export { processEvents, type ProcessorDeps, type ProactiveNotice } from './processor.js';
export {
  REPLACEMENT_WINDOW_MS,
  isFutureSlot,
  rankReplacements,
  replacementDateRange,
  slotClockTimeIst,
  type Preference,
  type ReplacementOption,
} from './replacements.js';

export interface ProactiveDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  engine: ProcessorDeps['engine'];
  queue: UserQueue;
  logger: Logger;
  /** See `rankReplacements`: `not_before` (`HH:MM` IST) and `max_price` (whole rupees). */
  prefs?: (userId: string) => Preference[];
  notify?: (userId: string, notice: ProactiveNotice) => void | Promise<void>;
  /** Passed through to `pollBookings`. */
  maxStatusCalls?: number;
}

export interface Proactive {
  /** One poll of upcoming bookings, then one pass over unprocessed events. */
  tick(): Promise<void>;
  /** Starts the poller. The returned function stops it. */
  start(intervalMs: number): () => void;
}

/**
 * Poll then process, serialized so two overlapping `tick`s can't double-propose.
 * `start` schedules that pair. The backend polls the provider; it does not
 * receive webhooks (plan §12, §19).
 */
export function createProactive(deps: ProactiveDeps): Proactive {
  const log = childLogger(deps.logger, 'proactive');
  let chain: Promise<void> = Promise.resolve();

  async function runOnce(): Promise<void> {
    await pollBookings(deps);
    await processEvents(deps);
  }

  function tick(): Promise<void> {
    const run = chain.then(runOnce, runOnce);
    chain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  return {
    tick,
    start(intervalMs: number): () => void {
      return startPoller({ intervalMs, tick, logger: log });
    },
  };
}
