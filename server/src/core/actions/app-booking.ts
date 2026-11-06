import type { Booking, BookingStatus } from '@bellhop/shared/contracts';
import type { AppBooking, Proposal } from '../types.js';

/** `user_id` always comes from the caller's session, never from the provider payload (invariant 2). */
export function toAppBooking(userId: string, booking: Booking, syncedAt: string): AppBooking {
  return {
    booking_id: booking.booking_id,
    user_id: userId,
    provider_id: booking.provider_id,
    provider_name: booking.provider_name,
    service: booking.service,
    slot: booking.slot,
    price: booking.price,
    currency: booking.currency,
    status: booking.status,
    synced_at: syncedAt,
  };
}

/** For a provider answer that confirms the effect but carries no booking body (e.g. `already_cancelled`). */
export function appBookingFromProposal(proposal: Proposal, status: BookingStatus, syncedAt: string): AppBooking {
  if (proposal.booking_id === null) {
    throw new Error(`proposal ${proposal.id} has no booking_id`);
  }
  return {
    booking_id: proposal.booking_id,
    user_id: proposal.user_id,
    provider_id: proposal.provider_id,
    provider_name: proposal.provider_name,
    service: proposal.service,
    slot: proposal.slot,
    price: proposal.price,
    currency: proposal.currency,
    status,
    synced_at: syncedAt,
  };
}
