import { describe, expect, it } from 'vitest';
import { ToolError } from '../../src/engine/errors.js';
import { createTestEngine, TEST_USER } from './helpers.js';

function searchFirstProvider(engine: ReturnType<typeof createTestEngine>['engine'], clock: ReturnType<typeof createTestEngine>['clock']) {
  const from = clock.now().toISOString();
  const to = new Date(clock.nowMs() + 14 * 24 * 60 * 60 * 1000).toISOString();
  const out = engine.searchProviders(TEST_USER, { service: 'plumber', area: 'Indiranagar', date_range: { from, to } });
  const provider = out.providers[0]!;
  return { provider, slot: provider.slots[0]! };
}

describe('holdSlot', () => {
  it('holds a slot for 10 minutes and marks it unavailable to others', () => {
    const { engine, clock } = createTestEngine();
    const { provider, slot } = searchFirstProvider(engine, clock);

    const before = clock.now().toISOString();
    const out = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });

    expect(out.hold.provider_id).toBe(provider.id);
    expect(out.hold.slot).toEqual(slot);
    expect(Date.parse(out.hold.expires_at) - Date.parse(before)).toBe(600_000);

    expect(() => engine.holdSlot(TEST_USER, { provider_id: provider.id, slot })).toThrow(ToolError);
  });

  it('lazily expires a hold after the TTL and reopens the slot', () => {
    const { engine, clock } = createTestEngine();
    const { provider, slot } = searchFirstProvider(engine, clock);

    engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });
    clock.advance(600_001);

    // Should succeed again: the stale hold is voided lazily, slot reopened.
    const out = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });
    expect(out.hold.slot).toEqual(slot);
  });

  it('throws slot_unavailable for a non-existent slot', () => {
    const { engine } = createTestEngine();
    expect(() =>
      engine.holdSlot(TEST_USER, {
        provider_id: 'prv_1',
        slot: { start: '2099-01-01T08:00:00+05:30', end: '2099-01-01T09:00:00+05:30' },
      }),
    ).toThrow(ToolError);
  });

  it('forces a price drift when PRICE_CHANGES_ON_HOLD is queued, and never drifts to the same price', () => {
    const { engine, clock, scenarios } = createTestEngine();
    const { provider, slot } = searchFirstProvider(engine, clock);

    scenarios.push(['PRICE_CHANGES_ON_HOLD']);
    const out = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });

    expect(out.hold.search_price).toBe(provider.price);
    expect(out.hold.price).not.toBe(provider.price);
    expect(out.hold.price % 10).toBe(0);
    expect(out.hold.price).toBeGreaterThanOrEqual(100);
  });

  it('never drifts the price when the drift probability is 0', () => {
    const { engine, clock } = createTestEngine({ config: { holdPriceDriftProbability: 0 } });
    const { provider, slot } = searchFirstProvider(engine, clock);

    const out = engine.holdSlot(TEST_USER, { provider_id: provider.id, slot });
    expect(out.hold.price).toBe(provider.price);
    expect(out.hold.price).toBe(out.hold.search_price);
  });
});
