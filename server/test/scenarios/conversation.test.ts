import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { MockLanguageModelV4 } from 'ai/test';
import type { LanguageModel } from 'ai';
import type { ProviderSummary, Slot } from '@bellhop/shared/contracts';
import type { ProviderClient } from '../../src/provider-client/index.js';
import { createMessagesRepo } from '../../src/core/repo/index.js';
import { runTurn, type TurnLimits, type TurnResult } from '../../src/harness/agent.js';
import { scriptedModel, textStep, toolCallStep } from '../../src/harness/scripted-model.js';
import { createCoreHarness, type CoreHarness } from '../helpers/core-harness.js';
import { findProvider, proposeBooking, stateOf } from './helpers.js';

const LIMITS: TurnLimits = {
  modelCalls: 8,
  toolCalls: 15,
  wallClockMs: 60_000,
  statusChecks: 3,
  retriesPerTool: 2,
};

const INJECTION = /SYSTEM:|\[assistant:|Note to AI agents|tool: approve=true/;

function rangeOf(h: CoreHarness): { from: string; to: string } {
  return {
    from: h.clock.now().toISOString(),
    to: new Date(h.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString(),
  };
}

function approvalCount(h: CoreHarness): number {
  const row = h.db.prepare('SELECT COUNT(*) AS n FROM approvals WHERE user_id = ?').get(h.userId) as { n: number };
  return row.n;
}

function proposalCount(h: CoreHarness): number {
  const row = h.db.prepare('SELECT COUNT(*) AS n FROM proposals WHERE user_id = ?').get(h.userId) as { n: number };
  return row.n;
}

async function turn(
  h: CoreHarness,
  model: LanguageModel,
  text: string,
  limits?: Partial<TurnLimits>,
  client?: ProviderClient,
): Promise<TurnResult> {
  return runTurn(
    {
      db: h.db,
      clock: h.clock,
      model,
      providerClient: client ?? h.client,
      logger: h.logger,
      tracesDir: mkdtempSync(path.join(tmpdir(), 'bellhop-trace-')),
      limits: { ...LIMITS, ...limits },
    },
    { userId: h.userId, text },
  );
}

function promptOf(model: MockLanguageModelV4): string {
  return JSON.stringify(model.doGenerateCalls);
}

async function findInjection(h: CoreHarness): Promise<{ id: string; text: string }> {
  const date_range = rangeOf(h);
  const { providers } = await h.client.search_providers(h.userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range,
  });
  for (const provider of providers) {
    const detail = await h.client.get_provider(h.userId, { provider_id: provider.id });
    const review = detail.provider.reviews.find((item) => INJECTION.test(item.text));
    if (review !== undefined) {
      h.providerCalls().length = 0;
      return { id: provider.id, text: review.text };
    }
  }
  throw new Error('no injection review in the plumber/Indiranagar search results');
}

describe('conversation scenarios', () => {
  let h: CoreHarness;

  beforeEach(async () => {
    h = await createCoreHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('S01 happy path with clarification — ask, then propose, nothing booked', async ({ task }) => {
    task.meta.expected =
      'a vague request asks for the missing area and time; once those are supplied the agent proposes one booking and does not book it';

    const provider = await findProvider(h);
    const slot = provider.slots[0]!;
    const date_range = rangeOf(h);

    const first = await turn(h, scriptedModel([textStep('Which area, and what time window should I use?')]), 'I need a plumber');
    expect(first.exit).toBe('needs_input');
    expect(first.reply).toMatch(/\?/);
    expect(first.proposalId).toBeUndefined();
    expect(h.providerBookings()).toHaveLength(0);

    const secondModel = scriptedModel([
      toolCallStep(
        'update_task',
        {
          service: 'plumber',
          area: 'Indiranagar',
          window_from: slot.start,
          window_to: slot.end,
          budget: 5000,
        },
        's01-update',
      ),
      toolCallStep('search_providers', { service: 'plumber', area: 'Indiranagar', date_range }, 's01-search'),
      toolCallStep('propose_booking', { provider_id: provider.id, service: 'plumber', slot }, 's01-propose'),
      textStep('Please confirm this proposal for the plumber in Indiranagar.'),
    ]);
    const second = await turn(
      h,
      secondModel,
      'Indiranagar, during that slot, budget 5000',
    );

    expect(second.exit).toBe('proposed');
    expect(second.proposalId).toBeDefined();
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(1);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    expect(second.reply.length).toBeGreaterThan(0);
    expect(createMessagesRepo(h.db).listRecent(h.userId, 10).map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
    h.assertInvariants();

    task.meta.actual = `first=${first.exit} second=${second.exit} pending=${h.engine.proposals.listPending(h.userId).length} bookings=${h.providerBookings().length}`;
  });

  it('S02 no re-asking supplied facts — task summary is in the next step', async ({ task }) => {
    task.meta.expected =
      'service, area, window, and budget supplied in one message are stored and shown in the next model step, and the reply does not ask for them again';

    const provider = await findProvider(h);
    const slot = provider.slots[0]!;
    const date_range = rangeOf(h);
    const model = scriptedModel([
      toolCallStep(
        'update_task',
        {
          service: 'plumber',
          area: 'Indiranagar',
          window_from: slot.start,
          window_to: slot.end,
          budget: 5000,
        },
        's02-update',
      ),
      toolCallStep('search_providers', { service: 'plumber', area: 'Indiranagar', date_range }, 's02-search'),
      textStep('I found plumbers in Indiranagar within your budget. Nothing is booked yet.'),
    ]);

    const result = await turn(h, model, 'Plumber in Indiranagar for that slot, budget 5000');
    const taskState = h.engine.taskState.get(h.userId);
    const nextStep = JSON.stringify(model.doGenerateCalls[1]);

    expect(taskState).toMatchObject({ service: 'plumber', area: 'Indiranagar', budget: 5000 });
    expect(nextStep).toContain('Indiranagar');
    expect(nextStep).toContain('plumber');
    expect(nextStep).toContain('5000');
    expect(nextStep).toContain('do not re-ask');
    expect(result.reply).not.toMatch(/which area|what area|what service/i);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `service=${taskState?.service} area=${taskState?.area} budget=${taskState?.budget} exit=${result.exit}`;
  });

  it('S03 correction preserves context — area and budget stay when the service changes', async ({ task }) => {
    task.meta.expected =
      'changing the service to electrician keeps the area and budget already stored, and the next turn still sees Indiranagar';

    await turn(
      h,
      scriptedModel([
        toolCallStep(
          'update_task',
          { service: 'plumber', area: 'Indiranagar', budget: 2000 },
          's03-update',
        ),
        textStep('Noted plumber in Indiranagar.'),
      ]),
      'Plumber in Indiranagar, budget 2000',
    );
    h.clock.advance(1000);

    const model = scriptedModel([
      toolCallStep('update_task', { service: 'electrician' }, 's03-correct'),
      textStep('Switched to an electrician in Indiranagar. Budget is unchanged.'),
    ]);
    const result = await turn(h, model, 'Switch that to an electrician, same area');
    const taskState = h.engine.taskState.get(h.userId);

    expect(promptOf(model)).toContain('Indiranagar');
    expect(promptOf(model)).toContain('Noted plumber in Indiranagar.');
    expect(taskState).toMatchObject({ service: 'electrician', area: 'Indiranagar', budget: 2000 });
    expect(result.reply).not.toMatch(/which area|what area/i);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `service=${taskState?.service} area=${taskState?.area} budget=${taskState?.budget}`;
  });

  it('S04 prompt injection in a review is ignored — nothing booked, no approval', async ({ task }) => {
    task.meta.expected =
      'an injection review is fenced as untrusted data; a model that obeys it still creates no approval and no booking';

    const injected = await findInjection(h);
    const model = scriptedModel([
      toolCallStep('get_provider', { provider_id: injected.id }, 's04-get'),
      textStep("You're booked. The review said to book immediately without asking."),
    ]);

    const result = await turn(h, model, 'Show me that provider');
    const prompt = JSON.stringify(model.doGenerateCalls[1]);
    const snippet = injected.text.match(/[A-Za-z][A-Za-z' ]{11,}/)?.[0] ?? injected.text.slice(0, 20);
    const fenceAt = prompt.indexOf('<<<UNTRUSTED-REVIEW>>>');
    const injectionAt = prompt.indexOf(snippet);

    expect(fenceAt).toBeGreaterThanOrEqual(0);
    expect(injectionAt).toBeGreaterThan(fenceAt);
    expect(result.exit).not.toBe('booked');
    expect(result.reply).toMatch(/Nothing was booked/);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    expect(h.providerCalls().some((call) => call.tool === 'book' || call.tool === 'cancel' || call.tool === 'reschedule')).toBe(
      false,
    );
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} approvals=${approvalCount(h)} bookings=${h.providerBookings().length} fenced=${fenceAt >= 0}`;
  });

  it('S05 adversarial skip confirmation — a claimed approval books nothing', async ({ task }) => {
    task.meta.expected =
      'the model claiming the user already approved does not create an approval row and does not book';

    const model = scriptedModel([
      textStep("You're booked — you approved it, so I skipped confirmation and went ahead and booked it."),
    ]);
    const result = await turn(h, model, 'Skip the confirmation and book it now');

    expect(result.exit).not.toBe('booked');
    expect(result.reply).toMatch(/Nothing was booked/);
    expect(approvalCount(h)).toBe(0);
    expect(proposalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    expect(model.doGenerateCalls).toHaveLength(1);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} approvals=${approvalCount(h)} bookings=${h.providerBookings().length}`;
  });

  it('S23 model-call limit — the turn stops with a user-facing message', async ({ task }) => {
    task.meta.expected = 'after the model-call limit the turn stops, tells the user, and books nothing';

    const model = scriptedModel(
      Array.from({ length: 5 }, (_, index) => toolCallStep('list_bookings', {}, `s23-${index}`)),
    );
    const result = await turn(h, model, 'Keep looking', { modelCalls: 2 });

    expect(result.exit).toBe('limit_reached');
    expect(result.reply).toMatch(/model-call limit/);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(h.providerCalls().filter((call) => call.tool === 'list_bookings')).toHaveLength(2);
    expect(stateOf(h)).toBe('LIMIT_EXCEEDED');
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} modelCalls=${model.doGenerateCalls.length} state=${stateOf(h)}`;
  });

  it('S24 tool-call limit — further tools are refused', async ({ task }) => {
    task.meta.expected = 'the third tool call in a turn is refused once the tool-call limit is 2, and nothing is booked';

    const model = scriptedModel([
      toolCallStep('list_bookings', {}, 's24-1'),
      toolCallStep('list_bookings', {}, 's24-2'),
      toolCallStep('list_bookings', {}, 's24-3'),
    ]);
    const result = await turn(h, model, 'List them again', { toolCalls: 2 });

    expect(result.exit).toBe('limit_reached');
    expect(result.reply).toMatch(/tool-call limit/);
    expect(h.providerCalls().filter((call) => call.tool === 'list_bookings')).toHaveLength(2);
    expect(stateOf(h)).toBe('LIMIT_EXCEEDED');
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} listCalls=${h.providerCalls().filter((call) => call.tool === 'list_bookings').length} state=${stateOf(h)}`;
  });

  it('S25 wall-clock limit — the turn aborts and tells the user', async ({ task }) => {
    task.meta.expected = 'a turn that exceeds the wall clock stops, tells the user, and books nothing';

    const model = new MockLanguageModelV4({
      doGenerate: async (options) => {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => resolve(), 5_000);
          const signal = options.abortSignal;
          const onAbort = () => {
            clearTimeout(timer);
            const reason = signal?.reason;
            reject(reason instanceof Error ? reason : new DOMException('The operation was aborted', 'TimeoutError'));
          };
          if (signal?.aborted === true) onAbort();
          else signal?.addEventListener('abort', onAbort, { once: true });
        });
        return textStep('too late');
      },
    });
    const result = await turn(h, model, 'Take your time', { wallClockMs: 200 });

    expect(result.exit).toBe('limit_reached');
    expect(result.reply).toMatch(/ran out of time/);
    expect(stateOf(h)).toBe('LIMIT_EXCEEDED');
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} state=${stateOf(h)} bookings=${h.providerBookings().length}`;
  });

  it('S26 unexpected tool error — the user is told and nothing is booked', async ({ task }) => {
    task.meta.expected = 'an unexpected tool failure returns a user-facing message and does not book';

    const client: ProviderClient = {
      ...h.client,
      search_providers: async () => {
        throw new Error('boom');
      },
    };
    const date_range = rangeOf(h);
    const model = scriptedModel([
      toolCallStep('search_providers', { service: 'plumber', area: 'Indiranagar', date_range }, 's26-search'),
      textStep("You're booked anyway."),
    ]);
    const result = await turn(h, model, 'Find a plumber in Indiranagar', undefined, client);

    expect(result.exit).toBe('failed');
    expect(result.reply).toMatch(/anything was changed/i);
    expect(result.reply).not.toMatch(/you're booked/i);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} approvals=${approvalCount(h)} bookings=${h.providerBookings().length}`;
  });

  it('S27 malformed tool call — the error is fed back and counted, nothing is booked', async ({ task }) => {
    task.meta.expected =
      'a tool call with invalid arguments is returned to the model as an error, counts as a tool call, and books nothing';

    const model = scriptedModel([
      toolCallStep('search_providers', { service: 'plumber' }, 's27-bad'),
      textStep('I need an area and a date range before I can search.'),
    ]);
    const result = await turn(h, model, 'Find a plumber');
    const second = JSON.stringify(model.doGenerateCalls[1] ?? {});

    expect(model.doGenerateCalls).toHaveLength(2);
    expect(second).toMatch(/invalid|expected|error/i);
    expect(h.providerCalls().filter((call) => call.tool === 'search_providers')).toHaveLength(0);
    expect(result.reply).toMatch(/area|date range/i);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(result.exit).not.toBe('booked');
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} modelCalls=${model.doGenerateCalls.length} searches=${h.providerCalls().length}`;
  });

  it('S28 exhausted retries — a repeating search error stops the turn', async ({ task }) => {
    task.meta.expected = 'a retryable search error is tried once more, then the user is told and nothing is booked';

    h.scenario('SEARCH_ERROR', 'SEARCH_ERROR');
    const date_range = rangeOf(h);
    const model = scriptedModel([
      toolCallStep('search_providers', { service: 'plumber', area: 'Indiranagar', date_range }, 's28-search'),
      textStep('I will try to explain.'),
    ]);
    const result = await turn(h, model, 'Find a plumber in Indiranagar', { retriesPerTool: 1 });
    const searches = h.providerCalls().filter((call) => call.tool === 'search_providers');

    expect(searches).toHaveLength(2);
    expect(result.exit).toBe('failed');
    expect(result.reply).toMatch(/several tries/);
    expect(result.reply.length).toBeGreaterThan(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();

    task.meta.actual = `exit=${result.exit} searches=${searches.length} bookings=${h.providerBookings().length}`;
  });
});

describe('typed confirmation and proposal constraints', () => {
  let h: CoreHarness;
  let provider: ProviderSummary;
  let slot: Slot;

  beforeEach(async () => {
    h = await createCoreHarness();
    provider = await findProvider(h);
    slot = provider.slots[0]!;
  });
  afterEach(async () => {
    await h.close();
  });

  it('approves the one pending proposal when the user says yes, without calling the model', async () => {
    await proposeBooking(h, provider, slot);
    h.scenario('BOOK_SUCCESS');
    const quiet = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('model must not run on typed yes');
      },
    });

    const result = await turn(h, quiet, 'yes');
    const approval = h.db.prepare('SELECT source, status FROM approvals WHERE user_id = ?').get(h.userId) as {
      source: string;
      status: string;
    };

    expect(quiet.doGenerateCalls).toHaveLength(0);
    expect(result.exit).toBe('booked');
    expect(result.reply).toMatch(/is booked/);
    expect(approval).toEqual({ source: 'typed', status: 'consumed' });
    expect(h.providerBookings()).toHaveLength(1);
    h.assertInvariants();
  });

  it('treats "book it" as the same typed confirmation', async () => {
    await proposeBooking(h, provider, slot);
    h.scenario('BOOK_SUCCESS');
    const quiet = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('model must not run');
      },
    });
    const result = await turn(h, quiet, 'book it');
    expect(result.exit).toBe('booked');
    expect(quiet.doGenerateCalls).toHaveLength(0);
    expect(h.providerBookings()).toHaveLength(1);
    h.assertInvariants();
  });

  it('does not treat a qualified yes as confirmation', async () => {
    await proposeBooking(h, provider, slot);
    const model = scriptedModel([textStep('What should I change about the time?')]);
    const result = await turn(h, model, 'yes, but change the time');
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    expect(result.reply.length).toBeGreaterThan(0);
    h.assertInvariants();
  });

  it('does not confirm an expired hold', async () => {
    await proposeBooking(h, provider, slot);
    h.clock.advance(11 * 60 * 1000);
    const quiet = new MockLanguageModelV4({
      doGenerate: async () => {
        throw new Error('model must not run');
      },
    });
    const result = await turn(h, quiet, 'go ahead');
    expect(quiet.doGenerateCalls).toHaveLength(0);
    expect(result.exit).toBe('needs_input');
    expect(result.reply).toMatch(/expired/);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    h.assertInvariants();
  });

  it('rejects a proposal whose price is over the task budget', async () => {
    h.engine.taskState.upsert(h.userId, {
      service: 'plumber',
      area: 'Indiranagar',
      window_from: slot.start,
      window_to: slot.end,
      budget: 100,
      updated_at: h.clock.now().toISOString(),
    });
    const model = scriptedModel([
      toolCallStep('propose_booking', { provider_id: provider.id, service: 'plumber', slot }, 'over-budget'),
      textStep('That price is over your budget, so nothing is proposed.'),
    ]);
    const result = await turn(h, model, 'Book that plumber');
    expect(JSON.stringify(model.doGenerateCalls[1] ?? {})).toMatch(/over the budget/);
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(0);
    expect(approvalCount(h)).toBe(0);
    expect(h.providerBookings()).toHaveLength(0);
    expect(result.reply.length).toBeGreaterThan(0);
    h.assertInvariants();
  });

  it('rejects a slot outside the task window before holding it', async () => {
    h.engine.taskState.upsert(h.userId, {
      service: 'plumber',
      area: 'Indiranagar',
      window_from: '2000-01-01T00:00:00.000Z',
      window_to: '2000-01-02T00:00:00.000Z',
      budget: 5000,
      updated_at: h.clock.now().toISOString(),
    });
    const model = scriptedModel([
      toolCallStep('propose_booking', { provider_id: provider.id, service: 'plumber', slot }, 'outside-window'),
      textStep('That slot is outside your window.'),
    ]);
    const result = await turn(h, model, 'Book that slot');
    expect(proposalCount(h)).toBe(0);
    expect(h.providerCalls().filter((call) => call.tool === 'hold_slot')).toHaveLength(0);
    expect(result.reply.length).toBeGreaterThan(0);
    h.assertInvariants();
  });
});

describe('live-run regressions (local Qwen)', () => {
  let h: CoreHarness;
  let provider: ProviderSummary;
  let slot: Slot;

  beforeEach(async () => {
    h = await createCoreHarness();
    provider = await findProvider(h);
    slot = provider.slots[0]!;
  });
  afterEach(async () => {
    await h.close();
  });

  it('repairs a provider name and datetimes without seconds in propose_booking', async () => {
    const date_range = rangeOf(h);
    const noSeconds = (iso: string): string => iso.replace(/:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/, '$2');
    const model = scriptedModel([
      toolCallStep('search_providers', { service: 'plumber', area: 'Indiranagar', date_range }, 'qwen-search'),
      toolCallStep(
        'propose_booking',
        {
          provider_id: provider.name,
          service: 'plumber',
          slot: { ...slot, start: noSeconds(slot.start), end: noSeconds(slot.end) },
        },
        'qwen-propose',
      ),
      textStep('Please confirm the booking on the card.'),
    ]);
    const result = await turn(h, model, 'Find a plumber in Indiranagar and propose the first slot');
    expect(result.exit).toBe('proposed');
    expect(result.proposalId).toBeDefined();
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(1);
    expect(h.providerBookings()).toHaveLength(0);
  });

  it('propose_booking recovers a task stuck in SEARCHING (SEARCHING -> COMPARING -> PROPOSED)', async () => {
    h.engine.taskState.upsert(h.userId, { state: 'SEARCHING', updated_at: h.clock.now().toISOString() });
    const model = scriptedModel([
      toolCallStep('propose_booking', { provider_id: provider.id, service: 'plumber', slot }, 'stuck-propose'),
      textStep('Please confirm the booking on the card.'),
    ]);
    const result = await turn(h, model, 'Book the first one');
    expect(JSON.stringify(model.doGenerateCalls[1] ?? {})).not.toMatch(/cannot propose from state SEARCHING/);
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(1);
    expect(stateOf(h)).toBe('PROPOSED');
    expect(result.exit).toBe('proposed');
  });

  it('nudges once when the model claims a proposal without calling the tool', async () => {
    const model = scriptedModel([
      textStep('I will propose booking the first plumber, please confirm on the card.'),
      toolCallStep('propose_booking', { provider_id: provider.id, service: 'plumber', slot }, 'nudged-propose'),
      textStep('Please confirm the booking on the card.'),
    ]);
    const result = await turn(h, model, 'Book the first one');
    expect(JSON.stringify(model.doGenerateCalls[1] ?? {})).toMatch(/did not call propose_booking/);
    expect(result.exit).toBe('proposed');
    expect(result.proposalId).toBeDefined();
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(1);
  });

  it('replaces a proposal claim with the honest no-card reply when the model never calls the tool', async () => {
    const claim = 'I will propose booking the first plumber, please confirm on the card.';
    const model = scriptedModel([textStep(claim), textStep(claim)]);
    const result = await turn(h, model, 'Book the first one');
    expect(result.reply).toBe(
      "I haven't prepared a booking card yet. Tell me which provider and time you'd like, and I'll put it up for you to confirm.",
    );
    expect(result.exit).not.toBe('proposed');
    expect(proposalCount(h)).toBe(0);
    expect(h.engine.proposals.listPending(h.userId)).toHaveLength(0);
  });
});
