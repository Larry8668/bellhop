import type Database from 'better-sqlite3';
import { expect } from 'vitest';
import { createLogger, type Logger } from '@bellhop/shared/logger';
import { USER_ID_HEADER, type ScenarioName, type ToolName } from '@bellhop/shared/contracts';
import { startTestProvider, type StartTestProviderOptions, type TestProvider } from '@bellhop/provider/testing';
import { createProviderClient, type ProviderClient } from '../../src/provider-client/index.js';
import type { ExecutionLimits } from '../../src/core/actions/executor.js';
import { proposalHash } from '../../src/core/approvals/hash.js';
import { createCoreEngine, type CoreEngine } from '../../src/core/engine.js';
import { createBookingsRepo, createIntentsRepo } from '../../src/core/repo/index.js';
import type { Action, Approval, ApprovalSource, Proposal } from '../../src/core/types.js';
import { createTestDb, TEST_USER } from '../core/helpers.js';
import { createFakeTraceWriter, type FakeTraceWriter } from './fake-trace.js';

export interface CoreHarnessOptions {
  seed?: number;
  clockStartMs?: number;
  /** Executor limits (plan §8): bounded status checks / provider-call retries. */
  statusChecks?: number;
  retriesPerTool?: number;
}

/** One provider call the client sent this run, as seen on the wire. */
export interface ProviderCallRecord {
  tool: ToolName;
  userId: string;
  headers: Record<string, string>;
  body: unknown;
}

export interface CoreHarness {
  db: Database.Database;
  /** Same clock instance the provider advances internally (`provider.clock`), so both sides move together. */
  clock: TestProvider['clock'];
  provider: TestProvider;
  client: ProviderClient;
  trace: FakeTraceWriter;
  logger: Logger;
  userId: string;
  /** The Phase 2 services composed over this harness's db/clock/client/trace (see `createCoreEngine`). */
  engine: CoreEngine;
  /** Every provider call made so far, in order. Returns the live array — `.length = 0` resets it between phases of one test. */
  providerCalls(): ProviderCallRecord[];
  providerBookings(): ReturnType<TestProvider['engine']['admin']['state']>['bookings'];
  /** Queues forced outcomes for the next matching tool calls (plan §4 admin scenarios). */
  scenario(...outcomes: ScenarioName[]): void;
  /** Approves `proposal` as the harness user, with the proposal's own hash — never a model-supplied one (invariant 1). */
  approve(proposal: Proposal, source?: ApprovalSource): Approval;
  /** Plan §16 global invariants that hold without a model; call at the end of every scenario. */
  assertInvariants(): void;
  close(): Promise<void>;
}

/** Comfortably longer than the provider's forced timeout delay, short enough to keep tests fast. */
const CLIENT_TIMEOUT_MS = 300;
const PROVIDER_TIMEOUT_DELAY_MS = 800;
const DEFAULT_LIMITS: ExecutionLimits = { statusChecks: 3, retriesPerTool: 2 };

interface ConsumedApprovalRow {
  action: Action;
  provider_id: string;
  slot_start: string;
  slot_end: string;
  price: number;
  hash: string;
  booking_id: string | null;
}

/**
 * Real `startTestProvider` (over real HTTP) + a fresh in-memory core DB +
 * fake trace writer + silent logger + the Phase 2 engine wired over them —
 * the shared environment every core scenario test builds on.
 */
export async function createCoreHarness(opts: CoreHarnessOptions = {}): Promise<CoreHarness> {
  const providerOptions: StartTestProviderOptions = {
    timeoutDelayMs: PROVIDER_TIMEOUT_DELAY_MS,
    ...(opts.seed !== undefined ? { seed: opts.seed } : {}),
    ...(opts.clockStartMs !== undefined ? { clockStartMs: opts.clockStartMs } : {}),
  };
  const provider = await startTestProvider(providerOptions);

  const logger = createLogger({ name: 'core-harness', level: 'silent' });
  const calls: ProviderCallRecord[] = [];

  /** Records every outbound call (tool + headers) before handing it to the real `fetch`. */
  const spyFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const tool = url.split('/tools/')[1] as ToolName;
    const headers = { ...((init?.headers ?? {}) as Record<string, string>) };
    const body = JSON.parse(String(init?.body ?? 'null')) as unknown;
    calls.push({ tool, userId: headers[USER_ID_HEADER] ?? '', headers, body });
    return fetch(input, init);
  };

  const client = createProviderClient({
    baseUrl: provider.url,
    timeoutMs: CLIENT_TIMEOUT_MS,
    logger,
    fetch: spyFetch,
  });

  const db = createTestDb();
  const trace = createFakeTraceWriter();
  const userId = TEST_USER;
  const limits: ExecutionLimits = {
    statusChecks: opts.statusChecks ?? DEFAULT_LIMITS.statusChecks,
    retriesPerTool: opts.retriesPerTool ?? DEFAULT_LIMITS.retriesPerTool,
  };
  const engine = createCoreEngine({ db, clock: provider.clock, providerClient: client, trace, logger, limits });

  function approve(proposal: Proposal, source: ApprovalSource = 'button'): Approval {
    const result = engine.approvals.approve(userId, { proposal_id: proposal.id, hash: proposal.hash, source });
    if (!result.ok) throw new Error(`approve failed: ${result.reason}`);
    return result.approval;
  }

  /** Every `approvals x proposals` row this user has ever consumed — the only legitimate source of a booking (plan §7). */
  function consumedApprovals(): ConsumedApprovalRow[] {
    return db
      .prepare(
        `SELECT p.action as action, p.provider_id as provider_id, p.slot_start as slot_start, p.slot_end as slot_end,
                p.price as price, p.hash as hash, p.booking_id as booking_id
         FROM approvals a JOIN proposals p ON p.user_id = a.user_id AND p.id = a.proposal_id
         WHERE a.user_id = ? AND a.status = 'consumed'`,
      )
      .all(userId) as ConsumedApprovalRow[];
  }

  /**
   * Plan §16 global invariants that apply without a scripted model. (b) is
   * a best-effort proxy: the provider's admin surface drops `idempotency_key`
   * from a mapped `Booking`, so an exact per-key count isn't available —
   * see the Phase 2 wave 3a report for the gap this leaves open.
   */
  function assertInvariants(): void {
    const consumed = consumedApprovals();

    for (const row of consumed) {
      const recomputed = proposalHash({
        action: row.action,
        provider_id: row.provider_id,
        slot: { start: row.slot_start, end: row.slot_end },
        price: row.price,
        booking_id: row.booking_id,
      });
      expect(recomputed, 'consumed approval hash must match its proposal (plan §7)').toBe(row.hash);
    }

    // (a) every booking this user has traces back to a consumed approval whose proposal hash is valid.
    for (const booking of createBookingsRepo(db).list(userId)) {
      const matched = consumed.some(
        (row) =>
          row.provider_id === booking.provider_id &&
          row.slot_start === booking.slot.start &&
          row.slot_end === booking.slot.end &&
          row.price === booking.price,
      );
      expect(matched, `booking ${booking.booking_id} has no consumed approval with a matching (provider_id, slot, price)`).toBe(
        true,
      );
    }

    // (b) no more provider bookings than successful `book()` idempotency keys.
    const state = provider.engine.admin.state();
    const successfulBookKeys = state.idempotency.filter((e) => e.tool === 'book' && e.status === 200).length;
    const userBookings = state.bookings.filter((b) => b.user_id === userId);
    expect(
      userBookings.length,
      'at most one provider booking per idempotency key: bookings must not outnumber successful book() calls',
    ).toBeLessThanOrEqual(successfulBookKeys);

    // (c) user_id in every provider call this run equals the harness (session) user.
    for (const call of calls) {
      expect(call.userId, `provider call to ${call.tool} must carry the harness user's id`).toBe(userId);
    }

    // (d) no succeeded intent whose stored outcome is `unconfirmed` (never claim success on a maybe).
    for (const intent of createIntentsRepo(db).listByUser(userId)) {
      if (intent.status !== 'succeeded') continue;
      const outcome = intent.result as { kind?: string } | null;
      expect(
        outcome?.kind,
        `succeeded intent ${intent.idempotency_key} must not store an unconfirmed outcome`,
      ).not.toBe('unconfirmed');
    }
  }

  return {
    db,
    clock: provider.clock,
    provider,
    client,
    trace,
    logger,
    userId,
    engine,
    providerCalls: () => calls,
    providerBookings: () => provider.engine.admin.state().bookings.filter((b) => b.user_id === userId),
    scenario: (...outcomes: ScenarioName[]) => provider.scenarios.push(outcomes),
    approve,
    assertInvariants,
    async close(): Promise<void> {
      db.close();
      await provider.close();
    },
  };
}
