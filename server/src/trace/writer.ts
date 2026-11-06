import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Clock } from '@bellhop/shared/clock';
import { createLogger, childLogger } from '@bellhop/shared/logger';
import type { TraceEvent, TraceEventInput } from './types.js';

export interface TraceWriter {
  path: string;
  emit(event: TraceEventInput): void;
  /**
   * Runs `fn` with emits held back; they are written only if `fn` returns.
   * Wrap a db transaction in it so a rolled-back write never leaves a trace
   * record claiming it happened.
   */
  atomic<T>(fn: () => T): T;
}

/** Shared emit/atomic behaviour over a raw sink, reused by the file writer and the test fake. */
export function createEmitter(write: (event: TraceEventInput) => void): Pick<TraceWriter, 'emit' | 'atomic'> {
  let held: TraceEventInput[] | null = null;
  return {
    emit(event) {
      if (held !== null) held.push(event);
      else write(event);
    },
    atomic(fn) {
      const outer = held;
      held = [];
      let result;
      try {
        result = fn();
      } catch (err) {
        held = outer;
        throw err;
      }
      const flushed = held;
      held = outer;
      for (const event of flushed) this.emit(event);
      return result;
    },
  };
}

const traceLogger = createLogger({ name: 'bellhop-server' });

/**
 * Creates a JSONL trace writer for one run (plan §13). The file is append-
 * only and synchronous: trace events must land in order and survive a crash
 * immediately after being emitted, so there's no buffering to lose.
 */
export function createTraceWriter({
  dir,
  runId,
  clock,
}: {
  dir: string;
  runId: string;
  clock: Clock;
}): TraceWriter {
  mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `${runId}.jsonl`);
  const log = childLogger(traceLogger, 'trace', { run_id: runId });

  return {
    path: filePath,
    ...createEmitter((event) => {
      const fullEvent = {
        ...event,
        run_id: runId,
        ts: clock.now().toISOString(),
      } as TraceEvent;

      appendFileSync(filePath, `${JSON.stringify(fullEvent)}\n`);
      log.debug({ type: fullEvent.type }, 'trace event emitted');
    }),
  };
}
