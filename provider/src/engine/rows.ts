import type {
  Booking,
  BookingStatus,
  Hold,
  ProviderDetail,
  ProviderSummary,
  Review,
  Service,
  Slot,
} from '@bellhop/shared/contracts';

/** Row shapes and row → contract mappers (plan §4 — pure engine, no HTTP). */

export const CURRENCY = 'INR' as const;

export interface ProviderRow {
  id: string;
  name: string;
  service: Service;
  area: string;
  price: number;
  rating: number;
  description: string;
  years_active: number;
  attributes_json: string;
}

export interface SlotRow {
  provider_id: string;
  start: string;
  end: string;
  state: 'open' | 'held' | 'booked';
}

export interface ReviewRow {
  id: number;
  provider_id: string;
  author: string;
  rating: number;
  text: string;
}

export interface HoldRow {
  hold_id: string;
  provider_id: string;
  user_id: string;
  slot_start: string;
  slot_end: string;
  price: number;
  search_price: number;
  created_at: string;
  expires_at: string;
  state: 'active' | 'consumed' | 'void';
}

export interface BookingRow {
  booking_id: string;
  user_id: string;
  provider_id: string;
  slot_start: string;
  slot_end: string;
  price: number;
  status: BookingStatus;
  hold_id: string | null;
  idempotency_key: string | null;
  created_at: string;
  updated_at: string;
}

/** Booking row joined with its provider for the display fields the contract needs. */
export interface BookingJoinedRow extends BookingRow {
  provider_name: string;
  service: Service;
}

export function toSlot(row: { start: string; end: string }): Slot {
  return { start: row.start, end: row.end };
}

export function mapProviderSummary(row: ProviderRow, slots: Slot[]): ProviderSummary {
  return {
    id: row.id,
    name: row.name,
    service: row.service,
    area: row.area,
    price: row.price,
    currency: CURRENCY,
    rating: row.rating,
    slots,
    attributes: JSON.parse(row.attributes_json) as string[],
  };
}

export function mapProviderDetail(
  row: ProviderRow,
  slots: Slot[],
  reviews: ReviewRow[],
): ProviderDetail {
  return {
    ...mapProviderSummary(row, slots),
    description: row.description,
    years_active: row.years_active,
    reviews: reviews.map(
      (r): Review => ({ author: r.author, rating: r.rating, text: r.text }),
    ),
  };
}

export function mapHoldRow(row: HoldRow): Hold {
  return {
    hold_id: row.hold_id,
    provider_id: row.provider_id,
    user_id: row.user_id,
    slot: { start: row.slot_start, end: row.slot_end },
    price: row.price,
    search_price: row.search_price,
    currency: CURRENCY,
    expires_at: row.expires_at,
  };
}

export function mapBookingRow(row: BookingJoinedRow): Booking {
  return {
    booking_id: row.booking_id,
    user_id: row.user_id,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    service: row.service,
    slot: { start: row.slot_start, end: row.slot_end },
    price: row.price,
    currency: CURRENCY,
    status: row.status,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/** Numeric suffix of a readable id (`prv_12` → `12`) for stable tie-break sorts. */
export function idNumber(id: string): number {
  const n = Number(id.slice(id.lastIndexOf('_') + 1));
  return Number.isFinite(n) ? n : 0;
}
