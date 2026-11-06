import type Database from 'better-sqlite3';
import { createLogger } from '@bellhop/shared/logger';
import type { ProviderSummary, ScenarioName, Slot, ToolName } from '@bellhop/shared/contracts';
import { startTestProvider, type TestProvider } from '@bellhop/provider/testing';
import { createProviderClient, type ProviderClient } from '../../src/provider-client/index.js';
import { createApprovalService, type ApprovalService } from '../../src/core/approvals/service.js';
import { createIntentService, type IntentService } from '../../src/core/intents/service.js';
import { createProposalService, type ProposalService } from '../../src/core/proposals/service.js';
import { createExecutor, type ExecutionLimits, type Executor } from '../../src/core/actions/executor.js';
import { createStateMachine, type StateMachine } from '../../src/core/state/machine.js';
import { createTaskStateRepo } from '../../src/core/repo/index.js';
import type { Approval, Proposal, TaskStateName } from '../../src/core/types.js';
import { createFakeTraceWriter, type FakeTraceWriter } from '../helpers/fake-trace.js';
import { createTestDb, TEST_USER } from './helpers.js';

export interface ProviderCall {
  tool: ToolName;
  body: unknown;
}

export interface EngineHarness {
  tp: TestProvider;
  db: Database.Database;
  trace: FakeTraceWriter;
  providerClient: ProviderClient;
  stateMachine: StateMachine;
  intents: IntentService;
  proposals: ProposalService;
  approvals: ApprovalService;
  executor: Executor;
  /** Every tool request the server sent to the provider, in order. */
  calls: ProviderCall[];
  /** Runs synchronously before each provider request leaves the server. */
  onCall: ((call: ProviderCall) => void) | undefined;
  scenario(...outcomes: ScenarioName[]): void;
  state(userId?: string): TaskStateName;
  providerBookings(userId?: string): ReturnType<TestProvider['engine']['admin']['state']>['bookings'];
  close(): Promise<void>;
}

export const DEFAULT_LIMITS: ExecutionLimits = { statusChecks: 3, retriesPerTool: 2 };

/**
 * Client timeout is well below the provider's simulated delay so `TIMEOUT_*`
 * scenarios surface as client-side timeouts, but generous enough that a
 * normal call never trips it under a parallel full-suite run (a 40 ms value
 * turned a 503 into a "timeout" when the machine was loaded).
 */
const CLIENT_TIMEOUT_MS = 300;
const PROVIDER_TIMEOUT_DELAY_MS = 800;

export async function startEngineHarness(opts: { limits?: ExecutionLimits } = {}): Promise<EngineHarness> {
  const tp = await startTestProvider({ seed: 42, timeoutDelayMs: PROVIDER_TIMEOUT_DELAY_MS });
  const logger = createLogger({ name: 'engine-test', level: 'silent' });
  const db = createTestDb();
  const trace = createFakeTraceWriter();
  const clock = tp.clock;
  const calls: ProviderCall[] = [];

  const harness = { onCall: undefined } as EngineHarness;

  const spyFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const tool = url.split('/tools/')[1] as ToolName;
    const call: ProviderCall = { tool, body: JSON.parse(String(init?.body ?? 'null')) };
    calls.push(call);
    harness.onCall?.(call);
    return fetch(input, init);
  };

  const providerClient = createProviderClient({ baseUrl: tp.url, timeoutMs: CLIENT_TIMEOUT_MS, logger, fetch: spyFetch });
  const stateMachine = createStateMachine({ db, clock, trace, logger });
  const intents = createIntentService({ db, clock, trace, logger });
  const proposals = createProposalService({ db, clock, providerClient, stateMachine, trace, logger });
  const approvals = createApprovalService({ db, clock, stateMachine, trace, logger });
  const executor = createExecutor({
    db,
    clock,
    providerClient,
    proposals,
    approvals,
    intents,
    stateMachine,
    trace,
    logger,
    limits: opts.limits ?? DEFAULT_LIMITS,
  });
  const taskStateRepo = createTaskStateRepo(db);

  return Object.assign(harness, {
    tp,
    db,
    trace,
    providerClient,
    stateMachine,
    intents,
    proposals,
    approvals,
    executor,
    calls,
    scenario: (...outcomes: ScenarioName[]) => tp.scenarios.push(outcomes),
    state: (userId = TEST_USER) => taskStateRepo.get(userId)?.state ?? 'GATHERING',
    providerBookings: (userId = TEST_USER) =>
      tp.engine.admin.state().bookings.filter((b) => b.user_id === userId),
    close: () => tp.close(),
  });
}

export async function findProvider(h: EngineHarness, userId = TEST_USER): Promise<ProviderSummary> {
  const from = h.tp.clock.now().toISOString();
  const to = new Date(h.tp.clock.nowMs() + 7 * 24 * 60 * 60 * 1000).toISOString();
  const { providers } = await h.providerClient.search_providers(userId, {
    service: 'plumber',
    area: 'Indiranagar',
    date_range: { from, to },
  });
  const provider = providers.find((p) => p.slots.length >= 3);
  if (provider === undefined) throw new Error('seed has no provider with 3+ slots');
  h.calls.length = 0;
  return provider;
}

export async function proposeBooking(
  h: EngineHarness,
  provider: ProviderSummary,
  slot: Slot = provider.slots[0]!,
  userId = TEST_USER,
): Promise<Proposal> {
  const result = await h.proposals.proposeBooking(userId, {
    provider_id: provider.id,
    provider_name: provider.name,
    service: provider.service,
    slot,
  });
  if (!result.ok) throw new Error(`proposeBooking failed: ${result.code}`);
  h.calls.length = 0;
  return result.proposal;
}

export function approve(h: EngineHarness, proposal: Proposal, userId = TEST_USER): Approval {
  const result = h.approvals.approve(userId, { proposal_id: proposal.id, hash: proposal.hash, source: 'button' });
  if (!result.ok) throw new Error(`approve failed: ${result.reason}`);
  return result.approval;
}

/** Books `slot` end-to-end through the executor and resets the errand so a cancel/reschedule can be proposed. */
export async function bookThroughExecutor(
  h: EngineHarness,
  provider: ProviderSummary,
  slot: Slot = provider.slots[0]!,
): Promise<string> {
  const approval = approve(h, await proposeBooking(h, provider, slot));
  h.scenario('BOOK_SUCCESS');
  const outcome = await h.executor.execute(TEST_USER, approval.id);
  if (outcome.kind !== 'booked') throw new Error(`setup booking failed: ${outcome.kind}`);
  h.stateMachine.transition(TEST_USER, 'GATHERING', 'new errand');
  h.calls.length = 0;
  return outcome.booking.booking_id;
}

export function errorEvents(h: EngineHarness) {
  return h.trace.events.filter((e) => e.type === 'error');
}
