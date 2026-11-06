import type { Slot } from '@bellhop/shared/contracts';
import { z } from 'zod';

/**
 * How a cancelled booking is replaced (plan §12).
 *
 * Active preferences, when the caller supplies them, are `{ key, value }`
 * strings. Only these keys change the candidate list; anything else is ignored:
 * - `not_before` — `HH:MM` on a 24-hour clock, interpreted in IST (+05:30),
 *   the timezone the provider's slots are seeded in. A slot whose IST
 *   start is earlier is dropped. Several `not_before` prefs keep the latest.
 * - `max_price` — whole rupees. A provider whose listed price is higher is
 *   dropped. Several `max_price` prefs keep the lowest.
 * A value that doesn't match the shape of its key is ignored, so one bad
 * pref can't empty the list.
 *
 * "Best" among what's left: lowest listed price, then earliest slot start,
 * then highest rating, then provider id. The provider who just cancelled is
 * excluded — re-holding their slot is not a replacement. Slots that are not
 * strictly in the future (`start > now`) are excluded too.
 *
 * The search window is 14 days from now, the same horizon the provider seed
 * fills with slots (`provider/src/db/seed.ts`).
 */

export const REPLACEMENT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;
const TIME_OF_DAY = /^([01]\d|2[0-3]):[0-5]\d$/;
const WHOLE_RUPEES = /^\d+$/;

export const PreferenceSchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type Preference = z.infer<typeof PreferenceSchema>;

export interface ReplacementOption {
  providerId: string;
  providerName: string;
  rating: number;
  price: number;
  slot: Slot;
}

export function replacementDateRange(nowMs: number): { from: string; to: string } {
  return {
    from: new Date(nowMs).toISOString(),
    to: new Date(nowMs + REPLACEMENT_WINDOW_MS).toISOString(),
  };
}

/** `true` when `slotStart` parses and is strictly after `nowMs`. */
export function isFutureSlot(slotStart: string, nowMs: number): boolean {
  const startMs = Date.parse(slotStart);
  return Number.isFinite(startMs) && startMs > nowMs;
}

/** Clock time `HH:MM` of an ISO timestamp in IST. Empty when `iso` doesn't parse. */
export function slotClockTimeIst(iso: string): string {
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  const shifted = new Date(ms + IST_OFFSET_MS);
  const hh = String(shifted.getUTCHours()).padStart(2, '0');
  const mm = String(shifted.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

interface ActivePrefs {
  notBefore?: string;
  maxPrice?: number;
}

function activePrefs(prefs: readonly Preference[]): ActivePrefs {
  const active: ActivePrefs = {};
  for (const pref of prefs) {
    if (pref.key === 'not_before' && TIME_OF_DAY.test(pref.value)) {
      if (active.notBefore === undefined || pref.value > active.notBefore) active.notBefore = pref.value;
    } else if (pref.key === 'max_price' && WHOLE_RUPEES.test(pref.value)) {
      const price = Number(pref.value);
      if (active.maxPrice === undefined || price < active.maxPrice) active.maxPrice = price;
    }
  }
  return active;
}

function keeps(option: ReplacementOption, prefs: ActivePrefs, nowMs: number): boolean {
  if (!isFutureSlot(option.slot.start, nowMs)) return false;
  const time = slotClockTimeIst(option.slot.start);
  if (time.length === 0) return false;
  if (prefs.notBefore !== undefined && time < prefs.notBefore) return false;
  if (prefs.maxPrice !== undefined && option.price > prefs.maxPrice) return false;
  return true;
}

/**
 * Filtered, best-first. Does not mutate `options`.
 * `excludeProviderId` is the provider that cancelled.
 */
export function rankReplacements(
  options: readonly ReplacementOption[],
  prefs: readonly Preference[],
  opts: { excludeProviderId: string; nowMs: number },
): ReplacementOption[] {
  const active = activePrefs(prefs);
  const filtered = options.filter(
    (option) => option.providerId !== opts.excludeProviderId && keeps(option, active, opts.nowMs),
  );
  filtered.sort((a, b) => {
    if (a.price !== b.price) return a.price - b.price;
    const startDelta = Date.parse(a.slot.start) - Date.parse(b.slot.start);
    if (startDelta !== 0) return startDelta;
    if (a.rating !== b.rating) return b.rating - a.rating;
    if (a.providerId < b.providerId) return -1;
    if (a.providerId > b.providerId) return 1;
    return 0;
  });
  return filtered;
}
