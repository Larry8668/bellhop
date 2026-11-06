import type { ListBookingsOutput } from '@bellhop/shared/contracts';

/** The shape the web client renders (plan §14) — a trimmed view of the provider's `Booking`. */
export interface WebBooking {
  id: string;
  providerName: string;
  service: string;
  slot: { start: string; end: string };
  price: number;
  currency: string;
  status: string;
  when: 'past' | 'upcoming';
}

type ProviderBooking = ListBookingsOutput['bookings'][number];

export function toWebBooking(booking: ProviderBooking): WebBooking {
  return {
    id: booking.booking_id,
    providerName: booking.provider_name,
    service: booking.service,
    slot: { start: booking.slot.start, end: booking.slot.end },
    price: booking.price,
    currency: booking.currency,
    status: booking.status,
    when: booking.when,
  };
}

/** Upcoming first (soonest next), then past (most recently ended first). */
export function compareWebBookings(a: WebBooking, b: WebBooking): number {
  if (a.when !== b.when) return a.when === 'upcoming' ? -1 : 1;
  const aStart = Date.parse(a.slot.start);
  const bStart = Date.parse(b.slot.start);
  return a.when === 'upcoming' ? aStart - bStart : bStart - aStart;
}

export function sortWebBookings(bookings: ProviderBooking[]): WebBooking[] {
  return bookings.map(toWebBooking).sort(compareWebBookings);
}
