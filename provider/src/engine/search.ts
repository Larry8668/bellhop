import type {
  GetProviderInput,
  GetProviderOutput,
  SearchProvidersInput,
  SearchProvidersOutput,
  Slot,
} from '@bellhop/shared/contracts';
import type { EngineContext } from './types.js';
import { ToolError, assertUserId } from './errors.js';
import {
  idNumber,
  mapProviderDetail,
  mapProviderSummary,
  toSlot,
  type ProviderRow,
  type ReviewRow,
  type SlotRow,
} from './rows.js';

const MAX_SEARCH_RESULTS = 8;

export function searchProviders(
  ctx: EngineContext,
  userId: string,
  input: SearchProvidersInput,
): SearchProvidersOutput {
  assertUserId(userId);

  if (ctx.scenarios.take('search_providers') === 'SEARCH_ERROR') {
    throw new ToolError('search_error', 'search is temporarily unavailable');
  }

  const fromMs = Date.parse(input.date_range.from);
  const toMs = Date.parse(input.date_range.to);

  const providerRows = ctx.db
    .prepare(`SELECT * FROM providers WHERE service = ? AND LOWER(area) = LOWER(?)`)
    .all(input.service, input.area) as ProviderRow[];

  const matches: { provider: ProviderRow; slots: Slot[] }[] = [];

  for (const provider of providerRows) {
    const slotRows = ctx.db
      .prepare(`SELECT start, end FROM slots WHERE provider_id = ? AND state = 'open' ORDER BY start ASC`)
      .all(provider.id) as SlotRow[];

    const inRange = slotRows.filter((slot) => {
      const startMs = Date.parse(slot.start);
      return startMs >= fromMs && startMs <= toMs;
    });

    if (inRange.length > 0) {
      matches.push({ provider, slots: inRange.map(toSlot) });
    }
  }

  // Stable order: rating desc, then id asc.
  matches.sort((a, b) => {
    if (b.provider.rating !== a.provider.rating) return b.provider.rating - a.provider.rating;
    return idNumber(a.provider.id) - idNumber(b.provider.id);
  });

  const top = matches.slice(0, MAX_SEARCH_RESULTS);
  return { providers: top.map(({ provider, slots }) => mapProviderSummary(provider, slots)) };
}

export function getProvider(
  ctx: EngineContext,
  userId: string,
  input: GetProviderInput,
): GetProviderOutput {
  assertUserId(userId);

  const provider = ctx.db.prepare(`SELECT * FROM providers WHERE id = ?`).get(input.provider_id) as
    | ProviderRow
    | undefined;
  if (!provider) {
    throw new ToolError('provider_not_found', `no provider with id ${input.provider_id}`);
  }

  const slotRows = ctx.db
    .prepare(`SELECT start, end FROM slots WHERE provider_id = ? AND state = 'open' ORDER BY start ASC`)
    .all(input.provider_id) as SlotRow[];
  const reviewRows = ctx.db
    .prepare(`SELECT id, provider_id, author, rating, text FROM reviews WHERE provider_id = ?`)
    .all(input.provider_id) as ReviewRow[];

  return { provider: mapProviderDetail(provider, slotRows.map(toSlot), reviewRows) };
}
