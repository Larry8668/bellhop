import type Database from 'better-sqlite3';
import type { Hold, HoldSlotInput, HoldSlotOutput } from '@bellhop/shared/contracts';
import type { AdjustableClock } from '../clock.js';
import type { EngineContext } from './types.js';
import { ToolError, assertUserId } from './errors.js';
import { nextId } from './ids.js';
import { mapHoldRow, type HoldRow, type ProviderRow, type SlotRow } from './rows.js';

const MIN_HOLD_PRICE = 100;
const MAX_DRIFT_ATTEMPTS = 10;

/**
 * Voids any hold whose `expires_at` has passed and reopens its slot. Called
 * at the start of every engine method so expiry is always lazily applied
 * before that method's own logic runs.
 */
export function expireStaleHolds(db: Database.Database, clock: AdjustableClock): void {
  const nowMs = clock.nowMs();
  const activeHolds = db
    .prepare(`SELECT hold_id, provider_id, slot_start, expires_at FROM holds WHERE state = 'active'`)
    .all() as Pick<HoldRow, 'hold_id' | 'provider_id' | 'slot_start' | 'expires_at'>[];

  const stale = activeHolds.filter((hold) => Date.parse(hold.expires_at) <= nowMs);
  if (stale.length === 0) return;

  const voidHold = db.prepare(`UPDATE holds SET state = 'void' WHERE hold_id = ?`);
  const openSlot = db.prepare(
    `UPDATE slots SET state = 'open' WHERE provider_id = ? AND start = ? AND state = 'held'`,
  );

  db.transaction(() => {
    for (const hold of stale) {
      voidHold.run(hold.hold_id);
      openSlot.run(hold.provider_id, hold.slot_start);
    }
  })();
}

export function findHoldRow(db: Database.Database, holdId: string): HoldRow | undefined {
  return db.prepare(`SELECT * FROM holds WHERE hold_id = ?`).get(holdId) as HoldRow | undefined;
}

export function voidHoldAndOpenSlot(
  db: Database.Database,
  hold: Pick<HoldRow, 'hold_id' | 'provider_id' | 'slot_start'>,
): void {
  db.transaction(() => {
    db.prepare(`UPDATE holds SET state = 'void' WHERE hold_id = ?`).run(hold.hold_id);
    db.prepare(`UPDATE slots SET state = 'open' WHERE provider_id = ? AND start = ?`).run(
      hold.provider_id,
      hold.slot_start,
    );
  })();
}

export function listAllHolds(db: Database.Database): Hold[] {
  const rows = db.prepare(`SELECT * FROM holds ORDER BY created_at ASC`).all() as HoldRow[];
  return rows.map(mapHoldRow);
}

/** ±5–20% of `basePrice`, rounded to the nearest 10, never below 100, and
 * (when `forced`) never equal to `basePrice`. */
function driftPrice(basePrice: number, rng: EngineContext['rng'], forced: boolean): number {
  let candidate = basePrice;
  for (let attempt = 0; attempt < MAX_DRIFT_ATTEMPTS; attempt++) {
    const pct = rng.int(5, 21) / 100;
    const sign = rng.chance(0.5) ? 1 : -1;
    candidate = Math.max(MIN_HOLD_PRICE, Math.round((basePrice * (1 + sign * pct)) / 10) * 10);
    if (!forced || candidate !== basePrice) break;
  }
  return candidate;
}

export function holdSlot(ctx: EngineContext, userId: string, input: HoldSlotInput): HoldSlotOutput {
  assertUserId(userId);
  const { db, clock, rng, scenarios, config } = ctx;

  const slotRow = db
    .prepare(`SELECT * FROM slots WHERE provider_id = ? AND start = ?`)
    .get(input.provider_id, input.slot.start) as SlotRow | undefined;

  // A slot already covered by a different active hold is 'held', not
  // 'open', so this single state check covers both "no such slot" and
  // "someone else is already holding it".
  if (!slotRow || slotRow.end !== input.slot.end || slotRow.state !== 'open') {
    throw new ToolError('slot_unavailable', 'requested slot is not available');
  }

  const providerRow = db.prepare(`SELECT * FROM providers WHERE id = ?`).get(input.provider_id) as
    | ProviderRow
    | undefined;
  if (!providerRow) {
    throw new ToolError('slot_unavailable', 'requested slot is not available');
  }

  const scenario = scenarios.take('hold_slot');
  const forced = scenario === 'PRICE_CHANGES_ON_HOLD';
  const searchPrice = providerRow.price;
  const price =
    forced || rng.chance(config.holdPriceDriftProbability)
      ? driftPrice(searchPrice, rng, forced)
      : searchPrice;

  const holdId = nextId(db, 'hold');
  const createdAt = clock.now().toISOString();
  const expiresAt = new Date(clock.nowMs() + config.holdTtlMs).toISOString();

  db.transaction(() => {
    db.prepare(
      `INSERT INTO holds (hold_id, provider_id, user_id, slot_start, slot_end, price, search_price, created_at, expires_at, state)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')`,
    ).run(
      holdId,
      input.provider_id,
      userId,
      input.slot.start,
      input.slot.end,
      price,
      searchPrice,
      createdAt,
      expiresAt,
    );
    db.prepare(`UPDATE slots SET state = 'held' WHERE provider_id = ? AND start = ?`).run(
      input.provider_id,
      input.slot.start,
    );
  })();

  return {
    hold: mapHoldRow({
      hold_id: holdId,
      provider_id: input.provider_id,
      user_id: userId,
      slot_start: input.slot.start,
      slot_end: input.slot.end,
      price,
      search_price: searchPrice,
      created_at: createdAt,
      expires_at: expiresAt,
      state: 'active',
    }),
  };
}
