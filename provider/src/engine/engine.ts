import type Database from 'better-sqlite3';
import type { Logger } from '@bellhop/shared/logger';
import { childLogger } from '@bellhop/shared/logger';
import type { Rng } from '@bellhop/shared/rng';
import { createSeededRng } from '@bellhop/shared/rng';
import type {
  AdminStateResponse,
  Booking,
  BookInput,
  CancelInput,
  CancelOutput,
  GetBookingStatusInput,
  GetBookingStatusOutput,
  GetProviderInput,
  GetProviderOutput,
  HoldSlotInput,
  HoldSlotOutput,
  ListBookingsInput,
  ListBookingsOutput,
  RescheduleInput,
  RescheduleOutput,
  SearchProvidersInput,
  SearchProvidersOutput,
  ToolName,
} from '@bellhop/shared/contracts';
import type { AdjustableClock } from '../clock.js';
import { resetAllTables } from '../db/schema.js';
import { seedProviders } from '../db/seed.js';
import { getSeed } from '../db/meta.js';
import type { ScenarioQueue } from '../scenarios.js';
import { ToolError } from './errors.js';
import { expireStaleHolds, holdSlot as holdSlotImpl, listAllHolds } from './holds.js';
import { getProvider as getProviderImpl, searchProviders as searchProvidersImpl } from './search.js';
import {
  book as bookImpl,
  cancel as cancelImpl,
  cancelBookingByProvider as cancelBookingByProviderImpl,
  getBookingStatus as getBookingStatusImpl,
  listAllBookings,
  listBookings as listBookingsImpl,
  reschedule as rescheduleImpl,
  type BookResult,
} from './bookings.js';
import { listIdempotency } from './idempotency.js';
import type { EngineConfig, EngineContext } from './types.js';

export type { EngineConfig } from './types.js';
export { DEFAULT_ENGINE_CONFIG } from './types.js';
export type { BookResult } from './bookings.js';

export interface ProviderEngine {
  searchProviders(userId: string, input: SearchProvidersInput): SearchProvidersOutput;
  getProvider(userId: string, input: GetProviderInput): GetProviderOutput;
  holdSlot(userId: string, input: HoldSlotInput): HoldSlotOutput;
  book(userId: string, input: BookInput): BookResult;
  getBookingStatus(userId: string, input: GetBookingStatusInput): GetBookingStatusOutput;
  cancel(userId: string, input: CancelInput): CancelOutput;
  reschedule(userId: string, input: RescheduleInput): RescheduleOutput;
  listBookings(userId: string, input: ListBookingsInput): ListBookingsOutput;
  admin: {
    reset(seed?: number): void;
    cancelBookingByProvider(bookingId: string): Booking;
    state(): Omit<AdminStateResponse, 'timeout_delay_ms'>;
    seed(): number;
  };
}

export function createEngine(deps: {
  db: Database.Database;
  clock: AdjustableClock;
  rng: Rng;
  scenarios: ScenarioQueue;
  logger: Logger;
  config: EngineConfig;
}): ProviderEngine {
  const log = childLogger(deps.logger, 'engine');
  const ctx: EngineContext = { ...deps, logger: log };

  /** Lazy hold expiry + debug logging (tool, user, outcome) around every call. */
  function run<T>(tool: ToolName, userId: string, fn: () => T): T {
    expireStaleHolds(ctx.db, ctx.clock);
    try {
      const result = fn();
      log.debug({ tool, userId, outcome: 'ok' }, 'engine call');
      return result;
    } catch (err) {
      const code = err instanceof ToolError ? err.code : 'internal';
      log.debug({ tool, userId, outcome: 'error', code }, 'engine call');
      throw err;
    }
  }

  return {
    searchProviders(userId, input) {
      return run('search_providers', userId, () => searchProvidersImpl(ctx, userId, input));
    },
    getProvider(userId, input) {
      return run('get_provider', userId, () => getProviderImpl(ctx, userId, input));
    },
    holdSlot(userId, input) {
      return run('hold_slot', userId, () => holdSlotImpl(ctx, userId, input));
    },
    book(userId, input) {
      return run('book', userId, () => bookImpl(ctx, userId, input));
    },
    getBookingStatus(userId, input) {
      return run('get_booking_status', userId, () => getBookingStatusImpl(ctx, userId, input));
    },
    cancel(userId, input) {
      return run('cancel', userId, () => cancelImpl(ctx, userId, input));
    },
    reschedule(userId, input) {
      return run('reschedule', userId, () => rescheduleImpl(ctx, userId, input));
    },
    listBookings(userId, input) {
      return run('list_bookings', userId, () => listBookingsImpl(ctx, userId, input));
    },
    admin: {
      reset(seed) {
        const resolvedSeed = seed ?? getSeed(ctx.db);
        resetAllTables(ctx.db);
        const freshRng = createSeededRng(resolvedSeed);
        seedProviders(ctx.db, { rng: freshRng, clock: ctx.clock, seed: resolvedSeed });
        ctx.rng = freshRng;
        ctx.scenarios.clear();
        log.debug({ seed: resolvedSeed }, 'admin reset');
      },
      cancelBookingByProvider(bookingId) {
        const booking = cancelBookingByProviderImpl(ctx, bookingId);
        log.debug({ bookingId }, 'admin cancel booking by provider');
        return booking;
      },
      state() {
        return {
          now: ctx.clock.now().toISOString(),
          seed: getSeed(ctx.db),
          pending_scenarios: ctx.scenarios.pending(),
          holds: listAllHolds(ctx.db),
          bookings: listAllBookings(ctx.db),
          idempotency: listIdempotency(ctx.db),
        };
      },
      seed() {
        return getSeed(ctx.db);
      },
    },
  };
}
