import { describe, expect, it, vi } from 'vitest';
import { createLogger } from '@bellhop/shared/logger';
import { withSameKeyRetries, type ActionDeps, type ActionRun } from '../../../src/core/actions/context.js';
import { ProviderError } from '../../../src/provider-client/errors.js';
import { makeProposal } from '../fixtures.js';
import { TEST_USER } from '../helpers.js';

function stubDeps(retriesPerTool: number) {
  const unknown = vi.fn();
  const deps = {
    intents: { unknown },
    taskStateRepo: { get: () => ({ state: 'EXECUTING' }) },
    stateMachine: { transition: vi.fn() },
    limits: { statusChecks: 3, retriesPerTool },
    log: createLogger({ name: 'context-test', level: 'silent' }),
  } as unknown as ActionDeps;
  return { deps, unknown };
}

const run: ActionRun = {
  userId: TEST_USER,
  approvalId: 'appr_1',
  key: 'cancel_appr_1',
  proposal: makeProposal({ action: 'cancel', booking_id: 'bk_1', hold_id: null, hold_expires_at: null }),
};

describe('withSameKeyRetries', () => {
  it('timeouts until retries run out → unconfirmed carries the real attempt count, not 0', async () => {
    const { deps, unknown } = stubDeps(2);
    const attempt = vi.fn(() =>
      Promise.reject(new ProviderError({ tool: 'cancel', code: 'timeout', message: 't', status: null, timedOut: true })),
    );

    const result = await withSameKeyRetries(deps, run, attempt);

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ ok: false, outcome: { kind: 'unconfirmed', idempotency_key: run.key, checks: 3 } });
    expect(unknown).toHaveBeenCalledWith(run.key);
  });
});
