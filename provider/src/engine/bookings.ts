import type Database from 'better-sqlite3';
import type {
  Booking,
  BookInput,
  BookOutput,
  CancelInput,
  CancelOutput,
  GetBookingStatusInput,
  GetBookingStatusOutput,
  ListBookingsInput,
  ListBookingsOutput,
  RescheduleInput,
  RescheduleOutput,
  ScenarioName,
  Slot,
  ToolErrorCode,
} from '@bellhop/shared/contracts';
import type { EngineContext } from './types.js';
import { ToolError, assertUserId, toErrorBody } from './errors.js';
import { fingerprint, getIdempotency, putIdempotency } from './idempotency.js';
import { nextId } from './ids.js';
import { findHoldRow, voidHoldAndOpenSlot } from './holds.js';
import { mapBookingRow, type BookingJoinedRow, type HoldRow, type SlotRow } from './rows.js';

const RESCHEDULE_ALTERNATIVES_LIMIT = 3;

const BOOKING_SELECT = `
  SELECT b.booking_id, b.user_id, b.provider_id, p.name AS provider_name, p.service AS service,
         b.slot_start, b.slot_end, b.price, b.status, b.hold_id, b.idempotency_key,
         b.created_at, b.updated_at
  FROM bookings b
  JOIN providers p ON p.id = b.provider_id
`;

function findBookingRow(db: Database.Database, bookingId: string): BookingJoinedRow | undefined {
  return db.prepare(`${BOOKING_SELECT} WHERE b.booking_id = ?`).get(bookingId) as
    | BookingJoinedRow
    | undefined;
}

function findBookingByHoldId(db: Database.Database, holdId: string): BookingJoinedRow | undefined {
  return db.prepare(`${BOOKING_SELECT} WHERE b.hold_id = ?`).get(holdId) as BookingJoinedRow | undefined;
}

function findBookingByIdempotencyKey(
  db: Database.Database,
  key: string,
): BookingJoinedRow | undefined {
  return db.prepare(`${BOOKING_SELECT} WHERE b.idempotency_key = ?`).get(key) as
    | BookingJoinedRow
    | undefined;
}

export function listAllBookings(db: Database.Database): Booking[] {
  const rows = db.prepare(`${BOOKING_SELECT} ORDER BY b.created_at ASC`).all() as BookingJoinedRow[];
  return rows.map(mapBookingRow);
}

type BookOutcome = 'success' | 'slot_taken' | 'timeout_booked' | 'timeout_not_booked';

function resolveBookOutcome(
  scenario: ScenarioName | undefined,
  rng: EngineContext['rng'],
  config: EngineContext['config'],
): BookOutcome {
  if (scenario === 'BOOK_SUCCESS') return 'success';
  if (scenario === 'BOOK_SLOT_TAKEN') return 'slot_taken';
  if (scenario === 'TIMEOUT_BOOKED') return 'timeout_booked';
  if (scenario === 'TIMEOUT_NOT_BOOKED') return 'timeout_not_booked';

  const roll = rng.next();
  if (roll < config.bookSuccessP) return 'success';
  if (roll < config.bookSuccessP + config.bookSlotTakenP) return 'slot_taken';
  return rng.chance(config.timeoutBookedP) ? 'timeout_booked' : 'timeout_not_booked';
}

export type BookResult = { outcome: 'booked'; output: BookOutput } | { outcome: 'timeout'; booked: boolean };

export function book(ctx: EngineContext, userId: string, input: BookInput): BookResult {
  assertUserId(userId);
  const { db, clock, rng, scenarios, config } = ctx;

  const fp = fingerprint({ hold_id: input.hold_id });
  const existing = getIdempotency(db, 'book', input.idempotency_key);
  if (existing) {
    if (existing.fingerprint !== fp) {
      throw new ToolError('idempotency_mismatch', 'idempotency key reused with different arguments');
    }
    if (existing.status === 200) {
      return { outcome: 'booked', output: JSON.parse(existing.body_json) as BookOutput };
    }
    const body = JSON.parse(existing.body_json) as {
      error: { code: ToolErrorCode; message: string; details?: unknown };
    };
    throw new ToolError(body.error.code, body.error.message, body.error.details);
  }

  const hold = findHoldRow(db, input.hold_id);
  if (!hold || hold.user_id !== userId) {
    throw new ToolError('hold_not_found', 'no active hold with that id for this user');
  }

  const scenario = scenarios.take('book');

  if (scenario === 'HOLD_EXPIRED' || hold.state !== 'active') {
    if (hold.state === 'active') {
      voidHoldAndOpenSlot(db, hold);
    }
    throw new ToolError('hold_expired', 'hold has expired');
  }

  const outcome = resolveBookOutcome(scenario, rng, config);

  if (outcome === 'timeout_not_booked') {
    // Nothing written: a retry with the same key gets a fresh attempt.
    return { outcome: 'timeout', booked: false };
  }

  if (outcome === 'slot_taken') {
    db.transaction(() => {
      db.prepare(`UPDATE slots SET state = 'booked' WHERE provider_id = ? AND start = ?`).run(
        hold.provider_id,
        hold.slot_start,
      );
      db.prepare(`UPDATE holds SET state = 'void' WHERE hold_id = ?`).run(hold.hold_id);
    })();
    const err = new ToolError('slot_taken', 'slot was booked by someone else');
    putIdempotency(db, 'book', input.idempotency_key, fp, 409, toErrorBody(err));
    throw err;
  }

  // 'success' and 'timeout_booked' share the same writes.
  const bookingId = nextId(db, 'bk');
  const nowIso = clock.now().toISOString();
  db.transaction(() => {
    db.prepare(
      `INSERT INTO bookings (booking_id, user_id, provider_id, slot_start, slot_end, price, status, hold_id, idempotency_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, ?)`,
    ).run(
      bookingId,
      userId,
      hold.provider_id,
      hold.slot_start,
      hold.slot_end,
      hold.price,
      hold.hold_id,
      input.idempotency_key,
      nowIso,
      nowIso,
    );
    db.prepare(`UPDATE slots SET state = 'booked' WHERE provider_id = ? AND start = ?`).run(
      hold.provider_id,
      hold.slot_start,
    );
    db.prepare(`UPDATE holds SET state = 'consumed' WHERE hold_id = ?`).run(hold.hold_id);
  })();

  const bookingRow = findBookingRow(db, bookingId) as BookingJoinedRow;
  const output: BookOutput = { status: 'booked', booking: mapBookingRow(bookingRow) };
  putIdempotency(db, 'book', input.idempotency_key, fp, 200, output);

  if (outcome === 'timeout_booked') {
    return { outcome: 'timeout', booked: true };
  }
  return { outcome: 'booked', output };
}

export function getBookingStatus(
  ctx: EngineContext,
  userId: string,
  input: GetBookingStatusInput,
): GetBookingStatusOutput {
  assertUserId(userId);
  const { db } = ctx;

  let bookingRow: BookingJoinedRow | undefined;
  let holdRow: HoldRow | undefined;

  if (input.hold_id) {
    const hold = findHoldRow(db, input.hold_id);
    if (hold && hold.user_id === userId) {
      holdRow = hold;
      bookingRow = findBookingByHoldId(db, input.hold_id);
    }
  }

  if (!bookingRow && input.idempotency_key) {
    const row = findBookingByIdempotencyKey(db, input.idempotency_key);
    if (row && row.user_id === userId) {
      bookingRow = row;
    }
  }

  // Looked up by idempotency_key only: fill in the hold for display, still
  // scoped to this user so nothing leaks.
  if (bookingRow && !holdRow && bookingRow.hold_id) {
    const hold = findHoldRow(db, bookingRow.hold_id);
    if (hold && hold.user_id === userId) holdRow = hold;
  }

  return {
    status: bookingRow ? 'booked' : 'not_booked',
    booking: bookingRow ? mapBookingRow(bookingRow) : null,
    hold: holdRow
      ? {
          hold_id: holdRow.hold_id,
          expires_at: holdRow.expires_at,
          state: holdRow.state === 'void' ? 'expired' : holdRow.state,
        }
      : null,
  };
}

export function cancel(ctx: EngineContext, userId: string, input: CancelInput): CancelOutput {
  assertUserId(userId);
  const { db, clock, scenarios } = ctx;

  const fp = fingerprint({ booking_id: input.booking_id });
  const existing = getIdempotency(db, 'cancel', input.idempotency_key);
  if (existing) {
    if (existing.fingerprint !== fp) {
      throw new ToolError('idempotency_mismatch', 'idempotency key reused with different arguments');
    }
    if (existing.status === 200) {
      return JSON.parse(existing.body_json) as CancelOutput;
    }
    // status 503: the first attempt recorded a transient failure here;
    // this retry with the same key is allowed to actually succeed below.
  }

  const bookingRow = findBookingRow(db, input.booking_id);
  if (!bookingRow || bookingRow.user_id !== userId) {
    throw new ToolError('booking_not_found', 'no booking with that id for this user');
  }
  if (bookingRow.status === 'cancelled') {
    throw new ToolError('already_cancelled', 'booking is already cancelled');
  }

  const isRetryAfterTransient = existing !== undefined && existing.status === 503;
  if (!isRetryAfterTransient) {
    const scenario = scenarios.take('cancel');
    if (scenario !== 'CANCEL_OK') {
      const err = new ToolError('transient', 'provider temporarily unavailable, retry with the same key');
      putIdempotency(db, 'cancel', input.idempotency_key, fp, 503, toErrorBody(err));
      throw err;
    }
  }

  const nowIso = clock.now().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE booking_id = ?`).run(
      nowIso,
      input.booking_id,
    );
    db.prepare(`UPDATE slots SET state = 'open' WHERE provider_id = ? AND start = ?`).run(
      bookingRow.provider_id,
      bookingRow.slot_start,
    );
  })();

  const refreshed = findBookingRow(db, input.booking_id) as BookingJoinedRow;
  const output: CancelOutput = { status: 'cancelled', booking: mapBookingRow(refreshed) };
  putIdempotency(db, 'cancel', input.idempotency_key, fp, 200, output);
  return output;
}

function findNextOpenSlots(
  db: Database.Database,
  providerId: string,
  afterStart: string,
  limit: number,
): Slot[] {
  const rows = db
    .prepare(
      `SELECT start, end FROM slots WHERE provider_id = ? AND state = 'open' AND start > ? ORDER BY start ASC LIMIT ?`,
    )
    .all(providerId, afterStart, limit) as SlotRow[];
  return rows.map((row) => ({ start: row.start, end: row.end }));
}

export function reschedule(
  ctx: EngineContext,
  userId: string,
  input: RescheduleInput,
): RescheduleOutput {
  assertUserId(userId);
  const { db, clock, scenarios } = ctx;

  const fp = fingerprint({ booking_id: input.booking_id, slot: input.slot });
  const existing = getIdempotency(db, 'reschedule', input.idempotency_key);
  if (existing) {
    if (existing.fingerprint !== fp) {
      throw new ToolError('idempotency_mismatch', 'idempotency key reused with different arguments');
    }
    if (existing.status === 200) {
      return JSON.parse(existing.body_json) as RescheduleOutput;
    }
    const body = JSON.parse(existing.body_json) as {
      error: { code: ToolErrorCode; message: string; details?: unknown };
    };
    throw new ToolError(body.error.code, body.error.message, body.error.details);
  }

  const bookingRow = findBookingRow(db, input.booking_id);
  if (!bookingRow || bookingRow.user_id !== userId) {
    throw new ToolError('booking_not_found', 'no booking with that id for this user');
  }
  if (bookingRow.status === 'cancelled') {
    throw new ToolError('booking_cancelled', 'booking is cancelled');
  }

  const scenario = scenarios.take('reschedule');
  const targetSlot = db
    .prepare(`SELECT * FROM slots WHERE provider_id = ? AND start = ?`)
    .get(bookingRow.provider_id, input.slot.start) as SlotRow | undefined;
  const targetIsOpen =
    targetSlot !== undefined && targetSlot.end === input.slot.end && targetSlot.state === 'open';

  if (scenario === 'RESCHEDULE_CONFLICT' || !targetIsOpen) {
    const alternatives = findNextOpenSlots(
      db,
      bookingRow.provider_id,
      input.slot.start,
      RESCHEDULE_ALTERNATIVES_LIMIT,
    );
    const err = new ToolError('slot_conflict', 'requested slot is not available', { alternatives });
    putIdempotency(db, 'reschedule', input.idempotency_key, fp, 409, toErrorBody(err));
    throw err;
  }

  const previousSlot: Slot = { start: bookingRow.slot_start, end: bookingRow.slot_end };
  const nowIso = clock.now().toISOString();

  db.transaction(() => {
    db.prepare(`UPDATE slots SET state = 'open' WHERE provider_id = ? AND start = ?`).run(
      bookingRow.provider_id,
      previousSlot.start,
    );
    db.prepare(`UPDATE slots SET state = 'booked' WHERE provider_id = ? AND start = ?`).run(
      bookingRow.provider_id,
      input.slot.start,
    );
    db.prepare(
      `UPDATE bookings SET slot_start = ?, slot_end = ?, status = 'rescheduled', updated_at = ? WHERE booking_id = ?`,
    ).run(input.slot.start, input.slot.end, nowIso, input.booking_id);
  })();

  const refreshed = findBookingRow(db, input.booking_id) as BookingJoinedRow;
  const output: RescheduleOutput = {
    status: 'rescheduled',
    booking: mapBookingRow(refreshed),
    previous_slot: previousSlot,
  };
  putIdempotency(db, 'reschedule', input.idempotency_key, fp, 200, output);
  return output;
}

export function listBookings(
  ctx: EngineContext,
  userId: string,
  input: ListBookingsInput,
): ListBookingsOutput {
  assertUserId(userId);
  if (input.user_id !== userId) {
    throw new ToolError('unauthorized', "cannot list another user's bookings");
  }

  const rows = ctx.db
    .prepare(`${BOOKING_SELECT} WHERE b.user_id = ? ORDER BY b.slot_start ASC`)
    .all(userId) as BookingJoinedRow[];

  const nowMs = ctx.clock.nowMs();
  const bookings = rows.map((row) => ({
    ...mapBookingRow(row),
    when: (Date.parse(row.slot_start) < nowMs ? 'past' : 'upcoming') as 'past' | 'upcoming',
  }));

  return { bookings };
}

export function cancelBookingByProvider(ctx: EngineContext, bookingId: string): Booking {
  const { db, clock } = ctx;
  const bookingRow = findBookingRow(db, bookingId);
  if (!bookingRow) {
    throw new ToolError('booking_not_found', `no booking with id ${bookingId}`);
  }

  const nowIso = clock.now().toISOString();
  db.transaction(() => {
    db.prepare(`UPDATE bookings SET status = 'cancelled', updated_at = ? WHERE booking_id = ?`).run(
      nowIso,
      bookingId,
    );
    db.prepare(`UPDATE slots SET state = 'open' WHERE provider_id = ? AND start = ?`).run(
      bookingRow.provider_id,
      bookingRow.slot_start,
    );
    db.prepare(
      `INSERT INTO events (type, booking_id, user_id, created_at, consumed) VALUES ('provider_cancelled', ?, ?, ?, 0)`,
    ).run(bookingId, bookingRow.user_id, nowIso);
  })();

  return mapBookingRow(findBookingRow(db, bookingId) as BookingJoinedRow);
}
