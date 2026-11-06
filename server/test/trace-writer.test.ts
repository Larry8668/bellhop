import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createFakeClock } from '@bellhop/shared/clock';
import { createTraceWriter } from '../src/trace/writer.js';
import type { TraceEvent } from '../src/trace/types.js';

describe('createTraceWriter', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'bellhop-trace-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('appends one JSON line per emit, stamped with run_id and clock time', () => {
    const clock = createFakeClock(1_700_000_000_000);
    const writer = createTraceWriter({ dir, runId: 'run-1', clock });

    writer.emit({ type: 'state_transition', from: 'GATHERING', to: 'SEARCHING' });
    clock.advance(1_000);
    writer.emit({
      type: 'error',
      where: 'test',
      message: 'boom',
    });

    expect(writer.path).toBe(path.join(dir, 'run-1.jsonl'));

    const lines = readFileSync(writer.path, 'utf8').trim().split('\n');
    expect(lines).toHaveLength(2);

    const events = lines.map((line) => JSON.parse(line) as TraceEvent);
    expect(events[0]).toMatchObject({
      type: 'state_transition',
      run_id: 'run-1',
      ts: new Date(1_700_000_000_000).toISOString(),
      from: 'GATHERING',
      to: 'SEARCHING',
    });
    expect(events[1]).toMatchObject({
      type: 'error',
      run_id: 'run-1',
      ts: new Date(1_700_000_001_000).toISOString(),
      where: 'test',
      message: 'boom',
    });
  });
});
