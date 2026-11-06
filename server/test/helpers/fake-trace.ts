import type { TraceEventInput } from '../../src/trace/types.js';
import { createEmitter, type TraceWriter } from '../../src/trace/writer.js';

export interface FakeTraceWriter extends TraceWriter {
  events: TraceEventInput[];
}

/** In-memory stand-in for `createTraceWriter` — no filesystem, exposes `events[]` for assertions. */
export function createFakeTraceWriter(): FakeTraceWriter {
  const events: TraceEventInput[] = [];
  return {
    path: ':memory:',
    events,
    ...createEmitter((event) => {
      events.push(event);
    }),
  };
}
