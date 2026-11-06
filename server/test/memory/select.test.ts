import { describe, expect, it } from 'vitest';
import {
  estimateTokens,
  isRelevant,
  MEMORY_TOKEN_BUDGET,
  renderFactLine,
  selectFacts,
} from '../../src/memory/select.js';
import type { MemoryFact } from '../../src/memory/types.js';

function fact(overrides: Partial<MemoryFact> = {}): MemoryFact {
  return {
    id: overrides.id ?? '1',
    key: overrides.key ?? 'note',
    value: overrides.value ?? 'v',
    kind: overrides.kind ?? 'explicit',
    status: overrides.status ?? 'active',
    tags: overrides.tags ?? [],
  };
}

function factWithTokens(id: string, tokens: number, extra: Partial<MemoryFact> = {}): MemoryFact {
  const key = extra.key ?? 'k';
  const valueLen = tokens * 4 - `- ${key}: \n`.length;
  if (valueLen < 1) throw new Error(`cannot build a ${tokens}-token fact for key ${key}`);
  const built = fact({
    ...extra,
    id,
    key,
    value: 'x'.repeat(valueLen),
    tags: extra.tags ?? ['general'],
  });
  const got = estimateTokens(renderFactLine(built));
  if (got !== tokens) throw new Error(`token helper built ${got}, wanted ${tokens}`);
  return built;
}

const plumber = { service: 'plumber', area: 'Indiranagar' };

describe('isRelevant', () => {
  it('drops forgotten and unconfirmed facts even when the tags match', () => {
    const tags = ['service:plumber', 'general'];
    expect(isRelevant(fact({ status: 'forgotten', tags }), plumber)).toBe(false);
    expect(isRelevant(fact({ status: 'unconfirmed', tags }), plumber)).toBe(false);
  });

  it('includes untagged prefs and general facts, and a matching service or area tag', () => {
    expect(isRelevant(fact({ tags: [] }), plumber)).toBe(true);
    expect(isRelevant(fact({ tags: ['general'] }), plumber)).toBe(true);
    expect(isRelevant(fact({ tags: ['service:plumber'] }), plumber)).toBe(true);
    expect(isRelevant(fact({ tags: ['area:indiranagar'] }), { area: 'Indiranagar' })).toBe(true);
    expect(isRelevant(fact({ tags: ['service:ac_servicing'] }), { service: 'AC Servicing' })).toBe(true);
  });

  it('excludes a different service, a conflicting area, and an untagged-looking topic tag', () => {
    expect(isRelevant(fact({ tags: ['service:electrician'] }), plumber)).toBe(false);
    expect(isRelevant(fact({ tags: ['service:plumber', 'area:koramangala'] }), plumber)).toBe(false);
    expect(isRelevant(fact({ key: 'favorite_cuisine', tags: ['topic:food'] }), plumber)).toBe(false);
    expect(isRelevant(fact({ tags: ['service:ac_servicing'] }), { service: 'ac_service' })).toBe(false);
  });

  it('matches a key only when the fact has no service or area tag', () => {
    expect(isRelevant(fact({ key: 'preferred_electrician', tags: ['topic:note'] }), { service: 'electrician' })).toBe(
      true,
    );
    expect(
      isRelevant(fact({ key: 'preferred_electrician', tags: ['service:plumber'] }), { service: 'electrician' }),
    ).toBe(false);
  });

  it('keeps a service-wide fact when the turn has no area yet', () => {
    expect(isRelevant(fact({ tags: ['service:plumber', 'area:indiranagar'] }), { service: 'plumber' })).toBe(true);
    expect(isRelevant(fact({ tags: ['service:plumber'] }), {})).toBe(false);
    expect(isRelevant(fact({ tags: ['general'] }), {})).toBe(true);
  });
});

describe('selectFacts', () => {
  it('fills newest-first and skips a fact that would exceed the 800 token cap', () => {
    const huge = factWithTokens('huge', 500, { key: 'a' });
    const mid = factWithTokens('mid', 500, { key: 'b' });
    const small = factWithTokens('small', 100, { key: 'c' });
    const selected = selectFacts([huge, mid, small], {});
    expect(selected.map((item) => item.id)).toEqual(['huge', 'small']);
    const tokens = selected.reduce((sum, item) => sum + estimateTokens(renderFactLine(item)), 0);
    expect(tokens).toBeLessThanOrEqual(MEMORY_TOKEN_BUDGET);
  });

  it('does not include a single fact larger than the budget', () => {
    const big = factWithTokens('big', 801, { key: 'k' });
    const small = factWithTokens('small', 100, { key: 's' });
    expect(selectFacts([big], {}).map((item) => item.id)).toEqual([]);
    expect(selectFacts([big, small], {}).map((item) => item.id)).toEqual(['small']);
  });

  it('includes a fact that lands exactly on the budget', () => {
    const exact = factWithTokens('exact', MEMORY_TOKEN_BUDGET, { key: 'k' });
    expect(selectFacts([exact], {}).map((item) => item.id)).toEqual(['exact']);
  });
});
