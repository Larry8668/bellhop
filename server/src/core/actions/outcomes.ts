import { z } from 'zod';
import { SlotSchema, type Slot } from '@bellhop/shared/contracts';
import { AppBookingSchema, ProposalSchema, type AppBooking } from '../types.js';

export const ExecutionOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('booked'), booking: AppBookingSchema, replayed: z.boolean() }),
  z.object({ kind: z.literal('cancelled'), booking: AppBookingSchema, replayed: z.boolean() }),
  z.object({
    kind: z.literal('rescheduled'),
    booking: AppBookingSchema,
    previous_slot: SlotSchema,
    replayed: z.boolean(),
  }),
  z.object({
    kind: z.literal('needs_reapproval'),
    proposal: ProposalSchema,
    previous_price: z.number(),
    new_price: z.number(),
  }),
  z.object({
    kind: z.literal('slot_gone'),
    reason: z.enum(['slot_taken', 'slot_conflict', 'hold_expired']),
    alternatives: z.array(SlotSchema),
  }),
  z.object({ kind: z.literal('unconfirmed'), idempotency_key: z.string(), checks: z.number().int().nonnegative() }),
  z.object({
    kind: z.literal('rejected'),
    reason: z.enum(['approval_not_valid', 'approval_already_consumed', 'proposal_not_found']),
  }),
  z.object({ kind: z.literal('failed'), code: z.string(), message: z.string() }),
]);
export type ExecutionOutcome = z.infer<typeof ExecutionOutcomeSchema>;

/** Outcomes that mean the provider-side effect happened; only these are stored as an intent's success result. */
export type SuccessOutcome = Extract<ExecutionOutcome, { kind: 'booked' | 'cancelled' | 'rescheduled' }>;

export function isSuccessOutcome(outcome: ExecutionOutcome): outcome is SuccessOutcome {
  return outcome.kind === 'booked' || outcome.kind === 'cancelled' || outcome.kind === 'rescheduled';
}

function slotText(slot: Slot): string {
  return `${slot.start} – ${slot.end}`;
}

function bookingText(b: AppBooking): string {
  return `${b.provider_name} (${b.service}) on ${slotText(b.slot)} for ₹${b.price}`;
}

function alternativesText(alternatives: Slot[]): string {
  if (alternatives.length === 0) return '';
  return ` Other open times: ${alternatives.map(slotText).join('; ')}.`;
}

/** One plain sentence per outcome. `unconfirmed` never claims success (plan §8, §9). */
export function describeOutcome(outcome: ExecutionOutcome): string {
  switch (outcome.kind) {
    case 'booked':
      return outcome.replayed
        ? `This was already done earlier: ${bookingText(outcome.booking)} is booked.`
        : `Done: ${bookingText(outcome.booking)} is booked.`;
    case 'cancelled':
      return outcome.replayed
        ? `This was already done earlier: your booking with ${outcome.booking.provider_name} is cancelled.`
        : `Done: your booking with ${outcome.booking.provider_name} on ${slotText(outcome.booking.slot)} is cancelled.`;
    case 'rescheduled':
      return `${outcome.replayed ? 'This was already done earlier: ' : 'Done: '}your booking with ${
        outcome.booking.provider_name
      } moved from ${slotText(outcome.previous_slot)} to ${slotText(outcome.booking.slot)}.`;
    case 'needs_reapproval':
      return `The price changed from ₹${outcome.previous_price} to ₹${outcome.new_price}, so nothing was done yet — please review the updated card and confirm again.`;
    case 'slot_gone': {
      const why =
        outcome.reason === 'slot_taken'
          ? 'Someone else took that slot before it could be secured'
          : outcome.reason === 'slot_conflict'
            ? 'That new time is not available'
            : 'The hold on that slot expired and it could not be held again';
      return `${why}, so nothing was changed.${alternativesText(outcome.alternatives)}`;
    }
    case 'unconfirmed':
      return 'The provider did not answer in time, so this is unconfirmed: we are still checking whether it went through. Please do not retry yet.';
    case 'rejected':
      return outcome.reason === 'approval_already_consumed'
        ? 'That confirmation was already used, so nothing new was done.'
        : 'That confirmation is not valid any more, so nothing was done. Please review the latest card.';
    case 'failed':
      return `That did not go through (${outcome.code}), and nothing was changed.`;
  }
}
