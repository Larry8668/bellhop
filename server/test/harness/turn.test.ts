import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { LanguageModel } from 'ai';
import { createFakeClock } from '@bellhop/shared/clock';
import { createLogger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../../src/provider-client/index.js';
import { runTurn } from '../../src/harness/agent.js';
import { scriptedModel, textStep, toolCallStep } from '../../src/harness/scripted-model.js';
import type { ContextLogEntry, FactKind, HarnessMemory, MemoryFact } from '../../src/harness/types.js';
import { createTestDb, TEST_USER } from '../core/helpers.js';

describe('memory tools on a turn', () => {
  it('records model-written facts as inferred and does not inject unconfirmed facts', async () => {
    const db = createTestDb();
    const logs: ContextLogEntry[] = [];
    const stored: MemoryFact[] = [];
    const memory: HarnessMemory = {
      selectForContext: () => stored.filter((item) => item.status === 'active'),
      remember: (_userId, input) => {
        const created: MemoryFact = {
          id: 'fact_1',
          key: input.key,
          value: input.value,
          kind: input.kind,
          status: input.kind === 'explicit' ? 'active' : 'unconfirmed',
          tags: input.tags ?? [],
        };
        stored.push(created);
        return created;
      },
      forget: () => false,
      getProfile: () => stored,
      logContext: (entry) => logs.push(entry),
    };
    const seenKinds: FactKind[] = [];
    const remembering: HarnessMemory = {
      ...memory,
      remember: (userId, input) => {
        seenKinds.push(input.kind);
        return memory.remember(userId, input);
      },
    };
    const client = new Proxy({} as ProviderClient, {
      get() {
        return async () => {
          throw new Error('provider should not be called');
        };
      },
    });
    const model: LanguageModel = scriptedModel([
      toolCallStep('remember_fact', { key: 'gate', value: 'blue' }, 'mem-1'),
      textStep('I noted the gate colour as unconfirmed.'),
    ]);

    const result = await runTurn(
      {
        db,
        clock: createFakeClock(Date.parse('2026-11-07T09:00:00.000Z')),
        model,
        providerClient: client,
        logger: createLogger({ name: 'harness-test', level: 'silent' }),
        tracesDir: mkdtempSync(path.join(tmpdir(), 'bellhop-trace-')),
        limits: { modelCalls: 4, toolCalls: 4, wallClockMs: 5_000, statusChecks: 1, retriesPerTool: 0 },
        memory: remembering,
      },
      { userId: TEST_USER, text: 'Remember that the gate is blue' },
    );

    expect(seenKinds).toEqual(['inferred']);
    expect(stored[0]).toMatchObject({ key: 'gate', value: 'blue', kind: 'inferred', status: 'unconfirmed' });
    expect(logs.every((entry) => entry.factIds.length === 0)).toBe(true);
    expect(logs.length).toBeGreaterThanOrEqual(2);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.exit).not.toBe('booked');
    db.close();
  });
});
