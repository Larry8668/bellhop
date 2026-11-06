import type Database from 'better-sqlite3';
import type { BookingStatus, Currency, Service } from '@bellhop/shared/contracts';
import { AppBookingSchema, type AppBooking } from '../types.js';

interface BookingRow {
  booking_id: string;
  user_id: string;
  provider_id: string;
  provider_name: string;
  service: Service;
  slot_start: string;
  slot_end: string;
  price: number;
  currency: Currency;
  status: BookingStatus;
  synced_at: string;
}

function toDomain(row: BookingRow): AppBooking {
  return AppBookingSchema.parse({
    booking_id: row.booking_id,
    user_id: row.user_id,
    provider_id: row.provider_id,
    provider_name: row.provider_name,
    service: row.service,
    slot: { start: row.slot_start, end: row.slot_end },
    price: row.price,
    currency: row.currency,
    status: row.status,
    synced_at: row.synced_at,
  });
}

export interface BookingsRepo {
  /** Upserts the app-side view synced from the provider (plan §5), keyed on `booking_id`. */
  upsert(booking: AppBooking): void;
  get(userId: string, bookingId: string): AppBooking | undefined;
  list(userId: string): AppBooking[];
  /** Every user's rows of this status, earliest slot first. The poller scans confirmed bookings across users. */
  listByStatus(status: BookingStatus): AppBooking[];
}

export function createBookingsRepo(db: Database.Database): BookingsRepo {
  const upsertStmt = db.prepare(`
    INSERT INTO bookings (
      booking_id, user_id, provider_id, provider_name, service, slot_start, slot_end, price, currency, status, synced_at
    ) VALUES (
      @booking_id, @user_id, @provider_id, @provider_name, @service, @slot_start, @slot_end, @price, @currency, @status, @synced_at
    )
    ON CONFLICT (booking_id) DO UPDATE SET
      user_id = excluded.user_id,
      provider_id = excluded.provider_id,
      provider_name = excluded.provider_name,
      service = excluded.service,
      slot_start = excluded.slot_start,
      slot_end = excluded.slot_end,
      price = excluded.price,
      currency = excluded.currency,
      status = excluded.status,
      synced_at = excluded.synced_at
  `);
  const selectStmt = db.prepare('SELECT * FROM bookings WHERE user_id = ? AND booking_id = ?');
  const listStmt = db.prepare('SELECT * FROM bookings WHERE user_id = ? ORDER BY slot_start ASC');
  const listByStatusStmt = db.prepare('SELECT * FROM bookings WHERE status = ? ORDER BY slot_start ASC');

  return {
    upsert(booking: AppBooking): void {
      upsertStmt.run({
        booking_id: booking.booking_id,
        user_id: booking.user_id,
        provider_id: booking.provider_id,
        provider_name: booking.provider_name,
        service: booking.service,
        slot_start: booking.slot.start,
        slot_end: booking.slot.end,
        price: booking.price,
        currency: booking.currency,
        status: booking.status,
        synced_at: booking.synced_at,
      });
    },

    get(userId: string, bookingId: string): AppBooking | undefined {
      const row = selectStmt.get(userId, bookingId) as BookingRow | undefined;
      return row === undefined ? undefined : toDomain(row);
    },

    list(userId: string): AppBooking[] {
      return (listStmt.all(userId) as BookingRow[]).map(toDomain);
    },

    listByStatus(status: BookingStatus): AppBooking[] {
      return (listByStatusStmt.all(status) as BookingRow[]).map(toDomain);
    },
  };
}
