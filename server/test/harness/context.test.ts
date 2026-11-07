import { describe, expect, it } from 'vitest';
import type { ModelMessage } from 'ai';
import { buildTurnContext, clearStaleToolResults, formatNow, staleToolStub } from '../../src/harness/context.js';
import type { ContextLogEntry, HarnessMemory, MemoryFact } from '../../src/harness/types.js';

function fact(partial: Partial<MemoryFact> & Pick<MemoryFact, 'id' | 'status'>): MemoryFact {
  return {
    key: partial.key ?? partial.id,
    value: partial.value ?? partial.id,
    kind: partial.kind ?? 'explicit',
    tags: partial.tags ?? [],
    id: partial.id,
    status: partial.status,
  };
}

function toolMessage(toolName: string, payload: string): ModelMessage {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: `${toolName}-${payload}`,
        toolName,
        output: { type: 'json', value: { payload } },
      },
    ],
  };
}

function outputOf(message: ModelMessage): unknown {
  if (!Array.isArray(message.content)) return message.content;
  const part = message.content[0];
  if (part === undefined || !('output' in part)) return undefined;
  return part.output;
}

describe('context layer', () => {
  it('replaces older search_providers and get_provider results with a stub and keeps the latest', () => {
    const cleared = clearStaleToolResults([
      toolMessage('search_providers', 'old-search'),
      toolMessage('get_provider', 'old-provider'),
      toolMessage('search_providers', 'new-search'),
      toolMessage('get_provider', 'new-provider'),
      toolMessage('list_bookings', 'bookings-stay'),
    ]);

    expect(outputOf(cleared[0]!)).toEqual({ type: 'text', value: staleToolStub('search_providers') });
    expect(outputOf(cleared[1]!)).toEqual({ type: 'text', value: staleToolStub('get_provider') });
    expect(outputOf(cleared[2]!)).toEqual({ type: 'json', value: { payload: 'new-search' } });
    expect(outputOf(cleared[3]!)).toEqual({ type: 'json', value: { payload: 'new-provider' } });
    expect(outputOf(cleared[4]!)).toEqual({ type: 'json', value: { payload: 'bookings-stay' } });
  });

  it('trims older history so the chars/4 estimate fits the budget and keeps the latest turn', () => {
    const big = 'word '.repeat(800);
    const messages: ModelMessage[] = Array.from({ length: 6 }, (_, index) => ({
      role: 'user',
      content: `turn-${index} ${big}`,
    }));
    const last = messages[5]!;
    const one = buildTurnContext({
      userId: 'user_1',
      runId: 'turn_budget',
      step: 0,
      messages: [last],
      task: undefined,
      budgetTokens: 100_000,
      toolsTokens: 0,
    });
    const trimmed = buildTurnContext({
      userId: 'user_1',
      runId: 'turn_budget',
      step: 0,
      messages,
      task: undefined,
      budgetTokens: one.estTokens + 10,
      toolsTokens: 0,
    });

    expect(trimmed.messages).toHaveLength(1);
    expect(trimmed.messages[0]).toEqual(last);
    expect(trimmed.estTokens).toBeLessThanOrEqual(one.estTokens + 10);
    expect(trimmed.sections.history).toBeLessThan(
      buildTurnContext({
        userId: 'user_1',
        runId: 'turn_budget',
        step: 0,
        messages,
        task: undefined,
        budgetTokens: 100_000,
        toolsTokens: 0,
      }).sections.history,
    );
  });

  it('drops unconfirmed and forgotten facts before the prompt and the context log', () => {
    const logs: ContextLogEntry[] = [];
    const memory: HarnessMemory = {
      selectForContext: () => [
        fact({ id: 'active', status: 'active', key: 'area', value: 'Indiranagar' }),
        fact({ id: 'pending', status: 'unconfirmed', key: 'secret', value: 'do-not-inject' }),
        fact({ id: 'gone', status: 'forgotten', key: 'old', value: 'forgotten-value' }),
      ],
      remember: () => fact({ id: 'new', status: 'unconfirmed' }),
      forget: () => false,
      getProfile: () => [],
      logContext: (entry) => logs.push(entry),
    };

    const built = buildTurnContext({
      userId: 'user_1',
      runId: 'turn_mem',
      step: 2,
      messages: [{ role: 'user', content: 'find a plumber' }],
      task: undefined,
      budgetTokens: 8192,
      toolsTokens: 40,
      memory,
    });

    expect(built.instructions).toContain('Indiranagar');
    expect(built.instructions).not.toContain('do-not-inject');
    expect(built.instructions).not.toContain('forgotten-value');
    expect(built.factIds).toEqual(['active']);
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      userId: 'user_1',
      runId: 'turn_mem',
      step: 2,
      factIds: ['active'],
    });
    expect(logs[0]?.sections).toEqual({
      system: expect.any(Number),
      memories: expect.any(Number),
      task: expect.any(Number),
      history: expect.any(Number),
      tools: expect.any(Number),
    });
    expect(logs[0]?.estTokens).toBe(
      (logs[0]?.sections.system ?? 0) +
        (logs[0]?.sections.memories ?? 0) +
        (logs[0]?.sections.task ?? 0) +
        (logs[0]?.sections.history ?? 0) +
        (logs[0]?.sections.tools ?? 0),
    );
  });

  it('formatNow converts UTC to IST across midnight (weekday and date roll forward)', () => {
    // 2026-11-07 20:00Z is Sunday 2026-11-08 01:30 IST.
    const line = formatNow(new Date('2026-11-07T20:00:00Z'));
    expect(line).toContain('Current time: Sunday 2026-11-08T01:30:00+05:30 (Asia/Kolkata).');
    expect(formatNow(new Date('2026-11-07T10:00:00Z'))).toContain('Saturday 2026-11-07T15:30:00+05:30');
  });

  it('adds the IST current time and day-part rules to instructions only when now is passed', () => {
    const base = {
      userId: 'user_1',
      runId: 'turn_now',
      step: 0,
      messages: [{ role: 'user', content: 'plumber tomorrow afternoon' }] as ModelMessage[],
      task: undefined,
      budgetTokens: 100_000,
      toolsTokens: 0,
    };
    const withNow = buildTurnContext({ ...base, now: new Date('2026-11-07T10:00:00Z') });
    expect(withNow.instructions).toContain('Saturday 2026-11-07T15:30:00+05:30');
    expect(withNow.instructions).toContain('afternoon 12:00-17:00');
    expect(withNow.instructions).toContain('never ask the user for ISO format');
    expect(buildTurnContext(base).instructions).not.toContain('Current time:');
  });
});
