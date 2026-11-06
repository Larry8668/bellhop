import type Database from 'better-sqlite3';
import { z } from 'zod';
import type { Clock } from '@bellhop/shared/clock';
import {
  ServiceSchema,
  SlotSchema,
  type Hold,
  type Service,
  type Slot,
  type ToolErrorCode,
} from '@bellhop/shared/contracts';
import { childLogger, type Logger } from '@bellhop/shared/logger';
import type { ProviderClient } from '../../provider-client/client.js';
import { ProviderError } from '../../provider-client/errors.js';
import type { TraceWriter } from '../../trace/writer.js';
import { toAppBooking } from '../actions/app-booking.js';
import { createTracedCall } from '../actions/traced-call.js';
import { proposalHash } from '../approvals/hash.js';
import { newId } from '../ids.js';
import { createBookingsRepo, createProposalsRepo, createTaskStateRepo } from '../repo/index.js';
import { canTransition, type StateMachine } from '../state/machine.js';
import type { AppBooking, Proposal, TaskStateName } from '../types.js';

/**
 * Card text (name, service) comes from `get_provider`, never from the model.
 * `provider_name` is accepted and ignored so older callers still parse;
 * `service`, if given, must match the provider's real service.
 */
export const ProposeBookingInputSchema = z.object({
  provider_id: z.string().min(1),
  slot: SlotSchema,
  service: ServiceSchema.optional(),
  provider_name: z.string().optional(),
});
export type ProposeBookingInput = z.infer<typeof ProposeBookingInputSchema>;

export const ProposeCancelInputSchema = z.object({
  booking_id: z.string().min(1),
});
export type ProposeCancelInput = z.infer<typeof ProposeCancelInputSchema>;

export const ProposeRescheduleInputSchema = z.object({
  booking_id: z.string().min(1),
  slot: SlotSchema,
});
export type ProposeRescheduleInput = z.infer<typeof ProposeRescheduleInputSchema>;

/** `invalid_state`: the task state can't legally reach PROPOSED (e.g. DONE without a new errand). */
export type ProposalFailureCode = ToolErrorCode | 'invalid_state';

export type ProposeResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; code: ProposalFailureCode; message: string };

export type DeclineResult =
  | { ok: true; proposal: Proposal }
  | { ok: false; code: 'proposal_not_found' | 'proposal_not_pending'; message: string };

export type PendingProposal = Proposal & { expired: boolean };

export interface BookingProposalDetails {
  provider_name: string;
  service: Service;
}

export interface ProposalService {
  proposeBooking(userId: string, input: ProposeBookingInput): Promise<ProposeResult>;
  proposeCancel(userId: string, input: ProposeCancelInput): Promise<ProposeResult>;
  proposeReschedule(userId: string, input: ProposeRescheduleInput): Promise<ProposeResult>;
  /** Stores a pending `book` proposal for a hold already taken (the executor's re-hold on a price change). */
  proposeFromHold(userId: string, details: BookingProposalDetails, hold: Hold): Proposal;
  decline(userId: string, proposalId: string): DeclineResult;
  listPending(userId: string): PendingProposal[];
}

export interface ProposalServiceDeps {
  db: Database.Database;
  clock: Clock;
  providerClient: ProviderClient;
  stateMachine: StateMachine;
  trace: TraceWriter;
  logger: Logger;
  requestId?: string | undefined;
}

export function isHoldExpired(proposal: Proposal, nowMs: number): boolean {
  return proposal.hold_expires_at !== null && Date.parse(proposal.hold_expires_at) <= nowMs;
}

export function createProposalService(deps: ProposalServiceDeps): ProposalService {
  const { db, clock, providerClient, stateMachine, trace, logger, requestId } = deps;
  const log = childLogger(logger, 'proposals');
  const proposalsRepo = createProposalsRepo(db);
  const bookingsRepo = createBookingsRepo(db);
  const taskStateRepo = createTaskStateRepo(db);
  const tracedCall = createTracedCall({ providerClient, clock, trace, requestId });

  function currentState(userId: string) {
    return taskStateRepo.get(userId)?.state ?? 'GATHERING';
  }

  /** Plan §6: a terminal state means the previous errand is over; a new proposal starts a new one via GATHERING. */
  function isTerminal(state: TaskStateName): boolean {
    return state === 'DONE' || state === 'FAILED' || state === 'LIMIT_EXCEEDED';
  }

  function canEnterProposed(userId: string): boolean {
    const state = currentState(userId);
    if (isTerminal(state)) return canTransition(state, 'GATHERING');
    return state === 'PROPOSED' || canTransition(state, 'PROPOSED');
  }

  /** Must run inside the persisting transaction so the extra edge and the proposal land together. */
  function enterProposed(userId: string, reason: string): void {
    const state = currentState(userId);
    if (state === 'PROPOSED') return;
    if (isTerminal(state)) stateMachine.transition(userId, 'GATHERING', 'new errand after a finished one');
    stateMachine.transition(userId, 'PROPOSED', reason);
  }

  function invalidState(userId: string): ProposeResult {
    const state = currentState(userId);
    log.warn({ userId, state }, 'proposal rejected: state cannot reach PROPOSED');
    return { ok: false, code: 'invalid_state', message: `cannot propose from state ${state}` };
  }

  function providerFailure(userId: string, op: string, err: unknown): ProposeResult {
    if (err instanceof ProviderError) {
      log.warn({ userId, op, code: err.code }, 'proposal failed at provider');
      return { ok: false, code: err.code, message: err.message };
    }
    log.error({ err, userId, op }, 'proposal failed unexpectedly');
    throw new Error(`${op} failed`, { cause: err });
  }

  /** Plan §6: a new proposal supersedes any pending one; the state enters PROPOSED in the same transaction. */
  function persist(draft: Omit<Proposal, 'id' | 'status' | 'hash' | 'created_at' | 'updated_at'>): Proposal {
    const now = clock.now().toISOString();
    const proposal: Proposal = {
      ...draft,
      id: newId('prop'),
      hash: proposalHash({
        action: draft.action,
        provider_id: draft.provider_id,
        slot: draft.slot,
        price: draft.price,
        booking_id: draft.booking_id,
      }),
      status: 'pending',
      created_at: now,
      updated_at: now,
    };
    db.transaction(() => {
      const superseded = proposalsRepo.supersedePending(proposal.user_id, proposal.id, now);
      proposalsRepo.insert(proposal);
      enterProposed(proposal.user_id, `${proposal.action} proposal created`);
      log.info(
        { userId: proposal.user_id, proposalId: proposal.id, action: proposal.action, superseded },
        'proposal created',
      );
    })();
    return proposal;
  }

  function proposeFromHold(userId: string, details: BookingProposalDetails, hold: Hold): Proposal {
    return persist({
      user_id: userId,
      action: 'book',
      provider_id: hold.provider_id,
      provider_name: details.provider_name,
      service: details.service,
      slot: hold.slot,
      // Plan §7: the hold's quoted price, never the search price.
      price: hold.price,
      currency: hold.currency,
      booking_id: null,
      hold_id: hold.hold_id,
      hold_expires_at: hold.expires_at,
    });
  }

  async function findBooking(userId: string, bookingId: string): Promise<AppBooking | undefined> {
    const local = bookingsRepo.get(userId, bookingId);
    if (local !== undefined) return local;
    const { bookings } = await tracedCall('list_bookings', userId, { user_id: userId });
    const match = bookings.find((b) => b.booking_id === bookingId);
    if (match === undefined) return undefined;
    const synced = toAppBooking(userId, match, clock.now().toISOString());
    bookingsRepo.upsert(synced);
    return synced;
  }

  async function proposeOnBooking(
    userId: string,
    op: 'cancel' | 'reschedule',
    bookingId: string,
    newSlot: Slot | null,
  ): Promise<ProposeResult> {
    if (!canEnterProposed(userId)) return invalidState(userId);
    let booking: AppBooking | undefined;
    try {
      booking = await findBooking(userId, bookingId);
    } catch (err) {
      return providerFailure(userId, `propose_${op}`, err);
    }
    if (booking === undefined) {
      return { ok: false, code: 'booking_not_found', message: 'no booking with that id for this user' };
    }
    if (booking.status === 'cancelled') {
      return {
        ok: false,
        code: op === 'cancel' ? 'already_cancelled' : 'booking_cancelled',
        message: 'booking is already cancelled',
      };
    }
    const proposal = persist({
      user_id: userId,
      action: op,
      provider_id: booking.provider_id,
      provider_name: booking.provider_name,
      service: booking.service,
      slot: newSlot ?? booking.slot,
      price: booking.price,
      currency: booking.currency,
      booking_id: booking.booking_id,
      hold_id: null,
      hold_expires_at: null,
    });
    return { ok: true, proposal };
  }

  return {
    async proposeBooking(userId, rawInput) {
      const parsed = ProposeBookingInputSchema.safeParse(rawInput);
      if (!parsed.success) return { ok: false, code: 'bad_request', message: 'invalid propose_booking input' };
      const input = parsed.data;
      if (!canEnterProposed(userId)) return invalidState(userId);

      let details: BookingProposalDetails;
      try {
        const { provider } = await tracedCall('get_provider', userId, { provider_id: input.provider_id });
        details = { provider_name: provider.name, service: provider.service };
      } catch (err) {
        return providerFailure(userId, 'propose_booking', err);
      }
      if (input.service !== undefined && input.service !== details.service) {
        log.warn({ userId, providerId: input.provider_id }, 'proposal rejected: service does not match provider');
        return { ok: false, code: 'bad_request', message: 'service does not match the provider' };
      }

      let hold: Hold;
      try {
        ({ hold } = await tracedCall('hold_slot', userId, { provider_id: input.provider_id, slot: input.slot }));
      } catch (err) {
        return providerFailure(userId, 'propose_booking', err);
      }
      const proposal = proposeFromHold(userId, details, hold);
      return { ok: true, proposal };
    },

    async proposeCancel(userId, rawInput) {
      const parsed = ProposeCancelInputSchema.safeParse(rawInput);
      if (!parsed.success) return { ok: false, code: 'bad_request', message: 'invalid propose_cancel input' };
      return proposeOnBooking(userId, 'cancel', parsed.data.booking_id, null);
    },

    async proposeReschedule(userId, rawInput) {
      const parsed = ProposeRescheduleInputSchema.safeParse(rawInput);
      if (!parsed.success) return { ok: false, code: 'bad_request', message: 'invalid propose_reschedule input' };
      return proposeOnBooking(userId, 'reschedule', parsed.data.booking_id, parsed.data.slot);
    },

    proposeFromHold,

    decline(userId, proposalId) {
      const proposal = proposalsRepo.get(userId, proposalId);
      if (proposal === undefined) {
        return { ok: false, code: 'proposal_not_found', message: 'no such proposal' };
      }
      if (proposal.status !== 'pending') {
        return { ok: false, code: 'proposal_not_pending', message: `proposal is ${proposal.status}` };
      }
      const now = clock.now().toISOString();
      db.transaction(() => {
        proposalsRepo.setStatus(userId, proposalId, 'declined', now);
        if (currentState(userId) === 'PROPOSED') {
          stateMachine.transition(userId, 'SEARCHING', 'proposal declined');
        }
      })();
      log.info({ userId, proposalId }, 'proposal declined');
      return { ok: true, proposal: { ...proposal, status: 'declined', updated_at: now } };
    },

    listPending(userId) {
      const nowMs = clock.nowMs();
      return proposalsRepo.listPending(userId).map((p) => ({ ...p, expired: isHoldExpired(p, nowMs) }));
    },
  };
}
