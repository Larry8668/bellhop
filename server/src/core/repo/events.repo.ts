import type Database from 'better-sqlite3';
import { AppEventSchema, type AppEvent } from '../types.js';

interface EventRow {
  id: number;
  user_id: string;
  type: string;
  booking_id: string | null;
  payload_json: string;
  processed: number;
  created_at: string;
}

function toDomain(row: EventRow): AppEvent {
  return AppEventSchema.parse({
    id: row.id,
    user_id: row.user_id,
    type: row.type,
    booking_id: row.booking_id,
    payload: JSON.parse(row.payload_json) as unknown,
    processed: row.processed === 1,
    created_at: row.created_at,
  });
}

export interface NewEvent {
  user_id: string;
  type: string;
  booking_id: string | null;
  payload: unknown;
  created_at: string;
}

export interface EventsRepo {
  insert(event: NewEvent): AppEvent;
  /** Unprocessed events, optionally scoped to one user (plan §12's processor runs per-user). */
  listUnprocessed(userId?: string): AppEvent[];
  /** True when this booking already has an event of `type` (processed or not). */
  hasForBooking(type: string, bookingId: string): boolean;
  /** Compare-and-set `processed` 0 → 1. `true` only for the caller that won. */
  markProcessed(id: number): boolean;
}

export function createEventsRepo(db: Database.Database): EventsRepo {
  const insertStmt = db.prepare(`
    INSERT INTO events (user_id, type, booking_id, payload_json, processed, created_at)
    VALUES (@user_id, @type, @booking_id, @payload_json, 0, @created_at)
  `);
  const selectByIdStmt = db.prepare('SELECT * FROM events WHERE id = ?');
  const listUnprocessedAllStmt = db.prepare(`SELECT * FROM events WHERE processed = 0 ORDER BY created_at ASC`);
  const listUnprocessedForUserStmt = db.prepare(
    `SELECT * FROM events WHERE processed = 0 AND user_id = ? ORDER BY created_at ASC`,
  );
  const hasForBookingStmt = db.prepare(
    'SELECT 1 AS present FROM events WHERE type = ? AND booking_id = ? LIMIT 1',
  );
  const markProcessedStmt = db.prepare('UPDATE events SET processed = 1 WHERE id = ? AND processed = 0');

  return {
    insert(event: NewEvent): AppEvent {
      const result = insertStmt.run({
        user_id: event.user_id,
        type: event.type,
        booking_id: event.booking_id,
        payload_json: JSON.stringify(event.payload ?? {}),
        created_at: event.created_at,
      });
      const row = selectByIdStmt.get(Number(result.lastInsertRowid)) as EventRow;
      return toDomain(row);
    },

    listUnprocessed(userId?: string): AppEvent[] {
      const rows = (
        userId === undefined ? listUnprocessedAllStmt.all() : listUnprocessedForUserStmt.all(userId)
      ) as EventRow[];
      return rows.map(toDomain);
    },

    hasForBooking(type: string, bookingId: string): boolean {
      return hasForBookingStmt.get(type, bookingId) !== undefined;
    },

    markProcessed(id: number): boolean {
      return markProcessedStmt.run(id).changes === 1;
    },
  };
}
