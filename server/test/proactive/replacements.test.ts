import { describe, expect, it } from 'vitest';
import { rankReplacements, slotClockTimeIst, type ReplacementOption } from '../../src/proactive/replacements.js';

const NOW_MS = Date.parse('2026-11-06T08:00:00+05:30');

function option(overrides: Partial<ReplacementOption> & { hour: number; price: number }): ReplacementOption {
  const hh = String(overrides.hour).padStart(2, '0');
  return {
    providerId: overrides.providerId ?? 'prv_a',
    providerName: overrides.providerName ?? 'A',
    rating: overrides.rating ?? 4,
    price: overrides.price,
    slot: overrides.slot ?? {
      start: `2026-11-06T${hh}:00:00+05:30`,
      end: `2026-11-06T${String(overrides.hour + 1).padStart(2, '0')}:00:00+05:30`,
    },
  };
}

describe('rankReplacements', () => {
  it('reads slot clock time in IST, including a Zulu timestamp', () => {
    expect(slotClockTimeIst('2026-11-06T10:00:00+05:30')).toBe('10:00');
    expect(slotClockTimeIst('2026-11-06T04:30:00.000Z')).toBe('10:00');
  });

  it('drops early slots, expensive providers, and the provider who cancelled', () => {
    const options = [
      option({ providerId: 'prv_cancelled', hour: 11, price: 400 }),
      option({ providerId: 'prv_early', hour: 9, price: 400 }),
      option({ providerId: 'prv_pricey', hour: 11, price: 900 }),
      option({ providerId: 'prv_ok', hour: 11, price: 500 }),
    ];

    const ranked = rankReplacements(
      options,
      [
        { key: 'not_before', value: '10:00' },
        { key: 'max_price', value: '500' },
        { key: 'favourite_colour', value: 'blue' },
        { key: 'not_before', value: 'not-a-time' },
      ],
      { excludeProviderId: 'prv_cancelled', nowMs: NOW_MS },
    );

    expect(ranked.map((row) => row.providerId)).toEqual(['prv_ok']);
  });

  it('keeps the strictest not_before and the lowest max_price', () => {
    const options = [
      option({ providerId: 'prv_10', hour: 10, price: 400 }),
      option({ providerId: 'prv_12', hour: 12, price: 400 }),
      option({ providerId: 'prv_12_dear', hour: 12, price: 700 }),
    ];

    const ranked = rankReplacements(
      options,
      [
        { key: 'not_before', value: '10:00' },
        { key: 'not_before', value: '12:00' },
        { key: 'max_price', value: '900' },
        { key: 'max_price', value: '500' },
      ],
      { excludeProviderId: 'nobody', nowMs: NOW_MS },
    );

    expect(ranked.map((row) => row.providerId)).toEqual(['prv_12']);
  });

  it('orders by price, then earliest slot, then rating', () => {
    const options = [
      option({ providerId: 'prv_late', hour: 15, price: 400, rating: 4.9 }),
      option({ providerId: 'prv_cheap_later', hour: 12, price: 400, rating: 3.5 }),
      option({ providerId: 'prv_dear', hour: 9, price: 450, rating: 5 }),
      option({ providerId: 'prv_same_slot_better', hour: 11, price: 400, rating: 4.2 }),
      option({ providerId: 'prv_same_slot_worse', hour: 11, price: 400, rating: 3.9 }),
    ];

    const ranked = rankReplacements(options, [], { excludeProviderId: 'nobody', nowMs: NOW_MS });

    expect(ranked.map((row) => row.providerId)).toEqual([
      'prv_same_slot_better',
      'prv_same_slot_worse',
      'prv_cheap_later',
      'prv_late',
      'prv_dear',
    ]);
  });

  it('drops a slot that is not strictly in the future', () => {
    const nowMs = Date.parse('2026-11-06T10:00:00+05:30');
    const ranked = rankReplacements(
      [option({ providerId: 'prv_now', hour: 10, price: 400 }), option({ providerId: 'prv_later', hour: 11, price: 400 })],
      [],
      { excludeProviderId: 'nobody', nowMs },
    );

    expect(ranked.map((row) => row.providerId)).toEqual(['prv_later']);
  });
});
