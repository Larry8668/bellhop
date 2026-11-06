import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolError } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '../../src/testing.js';
import { advanceClock, holdFirstSlot, postTool } from './helpers.js';

describe('provider clock over HTTP (POST /__admin/clock)', () => {
  let tp: TestProvider;

  beforeEach(async () => {
    tp = await startTestProvider();
  });

  afterEach(async () => {
    await tp.close();
  });

  it('advancing past the 10-minute hold TTL expires the hold lazily on next use', async () => {
    const hold = await holdFirstSlot(tp);

    const now = await advanceClock(tp, 11 * 60_000);
    expect(new Date(now).getTime()).toBe(tp.clock.nowMs());

    const { status, body } = await postTool<ToolError>(tp, 'book', {
      hold_id: hold.hold_id,
      idempotency_key: 'k-clock-expired',
    });
    expect(status).toBe(410);
    expect(body.error.code).toBe('hold_expired');
  });
});
