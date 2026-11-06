import type Database from 'better-sqlite3';
import type { Clock } from '@bellhop/shared/clock';
import type { Logger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../provider-client/index.js';
import type { TraceWriter } from '../trace/writer.js';
import { createExecutor, type Executor, type ExecutionLimits } from './actions/executor.js';
import { createApprovalService, type ApprovalService } from './approvals/service.js';
import { createIntentService, type IntentService } from './intents/service.js';
import { createProposalService, type ProposalService } from './proposals/service.js';
import { createBookingsRepo, createTaskStateRepo, type BookingsRepo, type TaskStateRepo } from './repo/index.js';
import { createStateMachine, type StateMachine } from './state/machine.js';

export interface CoreEngineDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  /** Scoped to one run: build an engine per run (or per test) so every event lands in that run's file. */
  trace: TraceWriter;
  logger: Logger;
  limits: ExecutionLimits;
}

export interface CoreEngine {
  stateMachine: StateMachine;
  proposals: ProposalService;
  approvals: ApprovalService;
  intents: IntentService;
  executor: Executor;
  taskState: TaskStateRepo;
  bookings: BookingsRepo;
}

/**
 * Composes the Phase 2 services over one db/clock/trace. This is the only
 * constructor the API, MCP and agent layers should use; it keeps the wiring
 * (which service sees which repo) in one place.
 */
export function createCoreEngine(deps: CoreEngineDeps): CoreEngine {
  const { db, clock, providerClient, trace, logger, limits } = deps;
  const stateMachine = createStateMachine({ db, clock, trace, logger });
  const proposals = createProposalService({ db, clock, providerClient, stateMachine, trace, logger });
  const approvals = createApprovalService({ db, clock, stateMachine, trace, logger });
  const intents = createIntentService({ db, clock, trace, logger });
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
    limits,
  });

  return {
    stateMachine,
    proposals,
    approvals,
    intents,
    executor,
    taskState: createTaskStateRepo(db),
    bookings: createBookingsRepo(db),
  };
}
